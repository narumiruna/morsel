package auth

import (
	"bytes"
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func waitForInvitationQueryLock(t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, query string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1`, query).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("invitation request did not reach query lock")
}

func TestInvitationHoldsAuthorizationLocksThroughInsert(t *testing.T) {
	for _, change := range []string{"logout", "recovery", "demotion", "session deletion"} {
		t.Run(change, func(t *testing.T) {
			s, pool := testService(t)
			admin := enroll(t, s, pool)
			ctx := t.Context()
			id := testdb.AccountID(t, pool)
			// Block only grant insertion, after browser authorization has completed.
			blocker, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(ctx)
			if _, err = blocker.Exec(ctx, `LOCK TABLE auth_grants IN SHARE MODE`); err != nil {
				t.Fatal(err)
			}
			issued := make(chan *httptest.ResponseRecorder, 1)
			go func() { issued <- admin.request("POST", invitationsPath, []byte(`{}`)) }()
			waitForInvitationQueryLock(t, pool, "INSERT INTO auth_grants%")
			changed := make(chan error, 1)
			go func() {
				tx, err := pool.Begin(ctx)
				if err != nil {
					changed <- err
					return
				}
				defer tx.Rollback(ctx)
				if change == "session deletion" {
					_, err = tx.Exec(ctx, `DELETE FROM auth_sessions WHERE account_id=$1`, id)
				} else {
					var u *account
					u, err = lockAccount(ctx, tx, id, 1)
					if err == nil {
						switch change {
						case "logout":
							_, err = tx.Exec(ctx, `DELETE FROM auth_sessions WHERE account_id=$1`, id)
						case "recovery":
							err = replaceCredentials(ctx, tx, u, &webauthn.Credential{ID: randomBytes(32)}, "Recovered")
						case "demotion":
							_, err = tx.Exec(ctx, `UPDATE accounts SET role='user' WHERE id=$1`, id)
						}
					}
				}
				if err == nil {
					err = tx.Commit(ctx)
				}
				changed <- err
			}()
			if change == "session deletion" {
				waitForInvitationQueryLock(t, pool, "DELETE FROM auth_sessions WHERE account_id=%")
			} else {
				waitForAccountLock(t, pool)
			}
			if err = blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			result := readInvitation(t, <-issued)
			if err = <-changed; err != nil {
				t.Fatal(err)
			}
			token := invitationToken(t, result.InvitationURL)
			if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE token_hash=$1`, hashToken(token)) != 1 {
				t.Fatal("later authorization change revoked issued grant")
			}
			requireStatus(t, newBrowser(s).request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": token, "display_name": "Still valid"})), 200)
		})
	}
}

func TestInvitationFinishRechecksSignedInRecipientAfterInput(t *testing.T) {
	s, pool := testService(t)
	admin := enroll(t, s, pool)
	ctx := t.Context()
	token, err := IssueGrant(ctx, pool, "invite", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	guest := newBrowser(s)
	w := guest.request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": token, "display_name": "Recipient"}))
	requireStatus(t, w, 200)
	credential := newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
	// An expired cookie passes the first check. Reinstating it while the input
	// is read proves that completion checks the database again before insertion.
	if _, err = pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	slow := &blockedReader{entered: make(chan struct{}), release: make(chan struct{}), body: bytes.NewReader(credential)}
	r := httptest.NewRequest("POST", "/v1/auth/invite/finish", slow)
	r.Header.Set("Origin", s.origin)
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(admin.cookies[sessionCookie])
	r.AddCookie(guest.cookies[flowCookie])
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); s.ServeHTTP(w, r); result <- w }()
	select {
	case <-slow.entered:
	case <-time.After(3 * time.Second):
		close(slow.release)
		t.Fatal("finish did not read credential")
	}
	_, err = pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 day'`)
	close(slow.release)
	if err != nil {
		t.Fatal(err)
	}
	w = <-result
	requireStatus(t, w, 409)
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == sessionCookie {
			t.Fatal("finish overwrote session")
		}
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE token_hash=$1`, hashToken(token)) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM accounts`) != 1 {
		t.Fatal("signed-in completion consumed grant or created account")
	}
}
