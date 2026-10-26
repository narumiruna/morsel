package auth

import (
	"bytes"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestConsumedLoginRejectsRecoveryReplacementDespiteWallClock(t *testing.T) {
	for _, backwards := range []bool{false, true} {
		t.Run(map[bool]string{false: "equal", true: "backwards"}[backwards], func(t *testing.T) {
			s, pool := testService(t)
			_, original := enrollAuthenticator(t, s, pool)
			id := uuid.Must(uuid.FromBytes(original.user))
			var originalTime time.Time
			if err := pool.QueryRow(t.Context(), `SELECT created_at FROM passkey_credentials WHERE account_id=$1`, id).Scan(&originalTime); err != nil {
				t.Fatal(err)
			}
			pending := newBrowser(s)
			w := pending.request("POST", "/v1/auth/login/begin", []byte(`{}`))
			requireStatus(t, w, 200)
			loginOptions := append([]byte(nil), w.Body.Bytes()...)
			token, err := IssueGrant(t.Context(), pool, "recover", id)
			if err != nil {
				t.Fatal(err)
			}
			recovery := newBrowser(s)
			w = recovery.request("POST", "/v1/auth/recover/begin", encode(t, map[string]string{"token": token}))
			requireStatus(t, w, 200)
			replacement := newAuthenticator(t)
			registration := replacement.registration(t, w.Body.Bytes(), s.origin, true)
			assertion := replacement.assertion(t, loginOptions, s.origin, true)
			slow := &blockedReader{entered: make(chan struct{}), release: make(chan struct{}), body: bytes.NewReader(assertion)}
			var once sync.Once
			unblock := func() { once.Do(func() { close(slow.release) }) }
			defer unblock()
			r := httptest.NewRequest("POST", "/v1/auth/login/finish", slow)
			r.Header.Set("Origin", s.origin)
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(pending.cookies[flowCookie])
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() { response := httptest.NewRecorder(); s.ServeHTTP(response, r); result <- response }()
			select {
			case <-slow.entered:
			case <-time.After(3 * time.Second):
				t.Fatal("login did not consume flow before body read")
			}
			if testdb.Count(t, pool, `SELECT count(*) FROM auth_flows WHERE kind='login'`) != 0 {
				t.Fatal("login flow was not consumed")
			}
			requireStatus(t, recovery.request("POST", "/v1/auth/recover/finish", registration), 200)
			if backwards {
				originalTime = originalTime.Add(-time.Hour)
			}
			if _, err = pool.Exec(t.Context(), `UPDATE passkey_credentials SET created_at=$1 WHERE account_id=$2`, originalTime, id); err != nil {
				t.Fatal(err)
			}
			unblock()
			requireStatus(t, <-result, 400)
			if testdb.Count(t, pool, `SELECT count(*) FROM auth_sessions WHERE account_id=$1`, id) != 1 {
				t.Fatal("pre-recovery challenge created a replacement-credential session")
			}
			loginAuthenticator(t, s, replacement)
		})
	}
}

func TestLoginRechecksCredentialAfterAccountLock(t *testing.T) {
	for _, change := range []string{"delete", "recover same ID", "equal order", "later order"} {
		t.Run(change, func(t *testing.T) {
			s, pool := testService(t)
			_, a := enrollAuthenticator(t, s, pool)
			id := uuid.Must(uuid.FromBytes(a.user))
			pending := newBrowser(s)
			w := pending.request("POST", "/v1/auth/login/begin", []byte(`{}`))
			requireStatus(t, w, 200)
			assertion := a.assertion(t, w.Body.Bytes(), s.origin, true)
			var order int64
			if err := pool.QueryRow(t.Context(), `SELECT started_order FROM auth_flows WHERE token_hash=$1`, hashToken(pending.cookies[flowCookie].Value)).Scan(&order); err != nil {
				t.Fatal(err)
			}
			tx, err := pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(t.Context())
			u, err := lockAccount(t.Context(), tx, id, 1)
			if err != nil {
				t.Fatal(err)
			}
			if err = loadCredentials(t.Context(), tx, u); err != nil {
				t.Fatal(err)
			}
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() { result <- pending.request("POST", "/v1/auth/login/finish", assertion) }()
			waitForAccountLock(t, pool)
			switch change {
			case "delete":
				_, err = tx.Exec(t.Context(), `DELETE FROM passkey_credentials WHERE account_id=$1`, id)
			case "recover same ID":
				// Re-enrollment with exactly the same key and ID must still have a
				// new order. ID presence alone cannot authorize an old challenge.
				credential := u.Credentials[0]
				err = replaceCredentials(t.Context(), tx, u, &credential, "Replacement")
			case "equal order", "later order":
				if change == "later order" {
					order++
				}
				_, err = tx.Exec(t.Context(), `UPDATE passkey_credentials SET registered_order=$1 WHERE account_id=$2`, order, id)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(t.Context()); err != nil {
				t.Fatal(err)
			}
			requireStatus(t, <-result, 400)
		})
	}
}

func TestConcurrentRegistrationCannotAuthorizeEarlierLogin(t *testing.T) {
	s, pool := testService(t)
	owner, original := enrollAuthenticator(t, s, pool)
	id := uuid.Must(uuid.FromBytes(original.user))
	pending := newBrowser(s)
	w := pending.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	options := append([]byte(nil), w.Body.Bytes()...)
	w = owner.request("POST", "/v1/auth/passkey/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	added := newAuthenticator(t)
	registration := added.registration(t, w.Body.Bytes(), s.origin, true)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err = lockAccount(t.Context(), tx, id, 1); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- owner.request("POST", "/v1/auth/passkey/finish", registration) }()
	waitForAccountLock(t, pool)
	// A login cannot acquire an uncommitted registration by guessing its ID.
	requireStatus(t, pending.request("POST", "/v1/auth/login/finish", added.assertion(t, options, s.origin, true)), 400)
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, <-result, 200)
	loginAuthenticator(t, s, added)
}

func TestRecoveryDoesNotLockAnotherAccount(t *testing.T) {
	s, pool := testService(t)
	_, a := enrollAuthenticator(t, s, pool)
	second, b := inviteAuthenticator(t, s, pool, "Independent")
	id := uuid.Must(uuid.FromBytes(a.user))
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	u, err := lockAccount(t.Context(), tx, id, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err = replaceCredentials(t.Context(), tx, u, &webauthn.Credential{ID: randomBytes(32)}, "Replacement"); err != nil {
		t.Fatal(err)
	}
	// Account B remains usable while account A's recovery transaction is open.
	if second.state(t)["account_id"] != uuid.Must(uuid.FromBytes(b.user)).String() {
		t.Fatal("foreign recovery blocked or changed identity")
	}
	loginAuthenticator(t, s, b)
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
