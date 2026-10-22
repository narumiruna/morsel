package auth

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestAccountShareLifecycle(t *testing.T) {
	s, pool := testService(t)
	ctx := t.Context()
	// A share created before owner setup must remain available to management.
	repository := share.NewPostgresRepository(pool)
	id := uuid.New()
	token := "legacy-public-capability"
	var hash [32]byte
	copy(hash[:], hashToken(token))
	maxViews := int64(1)
	if _, err := repository.Create(ctx, share.CreateParams{ID: id, TokenHash: hash, Content: "# Private Markdown\nbody", MaxViews: &maxViews}); err != nil {
		t.Fatal(err)
	}
	b := enroll(t, s, pool)
	path := "/v1/account/shares/" + id.String()
	for _, endpoint := range []struct{ method, path string }{{"GET", "/v1/account/shares"}, {"GET", path}, {"DELETE", path}} {
		w := newBrowser(s).request(endpoint.method, endpoint.path, nil)
		requireStatus(t, w, 401)
		assertShareNoStore(t, w)
		r := httptest.NewRequest(endpoint.method, endpoint.path, nil)
		r.Header.Set("Authorization", "Bearer "+randomToken())
		r.Header.Set("Origin", s.origin)
		w = httptest.NewRecorder()
		s.ServeHTTP(w, r)
		requireStatus(t, w, 401)
		assertShareNoStore(t, w)
	}
	w := b.request("GET", "/v1/account/shares", nil)
	requireStatus(t, w, 200)
	assertShareNoStore(t, w)
	var page share.AdminPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != id || page.Items[0].Label != "# Private Markdown" || page.Items[0].Status != "active" || page.NextCursor != "" || strings.Contains(w.Body.String(), `"content"`) {
		t.Fatalf("metadata: %s", w.Body.String())
	}
	var fields map[string]json.RawMessage
	data, _ := json.Marshal(page.Items[0])
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 8 || string(fields["expires_at"]) != "null" || string(fields["revoked_at"]) != "null" {
		t.Fatalf("metadata fields: %s", data)
	}
	w = b.request("GET", path, nil)
	requireStatus(t, w, 200)
	assertShareNoStore(t, w)
	var detail share.AdminDetail
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil || detail.Content != "# Private Markdown\nbody" || detail.ViewCount != 0 {
		t.Fatalf("detail: %s %v", w.Body.String(), err)
	}
	if _, err := repository.Consume(ctx, hash); err != nil {
		t.Fatalf("admin read spent final view: %v", err)
	}
	requireStatus(t, b.request("GET", path, nil), 200)
	for _, status := range []string{"active", "view_limit_exhausted"} {
		w := b.request("GET", "/v1/account/shares?status="+status, nil)
		requireStatus(t, w, 200)
		var page share.AdminPage
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		want := 0
		if status == "view_limit_exhausted" {
			want = 1
		}
		if len(page.Items) != want {
			t.Fatalf("%s page: %s", status, w.Body.String())
		}
	}
	// Both same-origin and CSRF protections apply to DELETE.
	csrf := b.csrf
	b.csrf = "wrong"
	requireStatus(t, b.request("DELETE", path, nil), 403)
	b.csrf = csrf
	for _, origins := range [][]string{nil, {"http://evil.example"}, {s.origin, s.origin}} {
		r := httptest.NewRequest("DELETE", path, nil)
		r.Header["Origin"] = origins
		r.Header.Set("X-CSRF-Token", b.csrf)
		for _, c := range b.cookies {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		requireStatus(t, w, 403)
		assertShareNoStore(t, w)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '12 hours 1 second'`); err != nil {
		t.Fatal(err)
	}
	w = b.request("DELETE", path, nil)
	requireStatus(t, w, 403)
	if !strings.Contains(w.Body.String(), "verification_required") {
		t.Fatal(w.Body.String())
	}
	// Stale verification does not block non-consuming reads.
	requireStatus(t, b.request("GET", path, nil), 200)
	requireStatus(t, b.request("GET", "/v1/account/shares", nil), 200)
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET verified_at=clock_timestamp()`); err != nil {
		t.Fatal(err)
	}
	var revokedAt string
	for range 2 {
		w := b.request("DELETE", path, nil)
		requireStatus(t, w, 204)
		assertShareNoStore(t, w)
		if w.Body.Len() != 0 {
			t.Fatal("204 response has a body")
		}
		var current string
		if err := pool.QueryRow(ctx, `SELECT revoked_at::text FROM shares WHERE id=$1`, id).Scan(&current); err != nil {
			t.Fatal(err)
		}
		if revokedAt != "" && current != revokedAt {
			t.Fatal("repeat revocation changed timestamp")
		}
		revokedAt = current
	}
	w = b.request("GET", path, nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"status":"revoked"`) || !strings.Contains(w.Body.String(), `"content":"# Private Markdown\nbody"`) {
		t.Fatal(w.Body.String())
	}
	if _, err := repository.Consume(ctx, hash); err != share.ErrRevoked {
		t.Fatalf("original capability after revoke: %v", err)
	}
	if n := testdb.Count(t, pool, `SELECT view_count FROM shares WHERE id=$1`, id); n != 1 {
		t.Fatalf("management changed count to %d", n)
	}
	for _, method := range []string{"GET", "DELETE"} {
		w := b.request(method, "/v1/account/shares/"+uuid.NewString(), nil)
		requireStatus(t, w, 404)
		assertShareNoStore(t, w)
	}
}

func assertShareNoStore(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "token_hash") || strings.Contains(w.Body.String(), "legacy-public-capability") {
		t.Fatalf("unsafe response: %v %s", w.Header(), w.Body.String())
	}
}

func TestAccountShareParametersAndPagination(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	if _, err := pool.Exec(t.Context(), `INSERT INTO shares(id,token_hash,content)
		SELECT md5(n::text)::uuid,sha256(convert_to(n::text,'UTF8')),'row '||n FROM generate_series(1,26) n`); err != nil {
		t.Fatal(err)
	}
	w := b.request("GET", "/v1/account/shares", nil)
	requireStatus(t, w, 200)
	var page share.AdminPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Items) != 25 || page.NextCursor == "" {
		t.Fatalf("default page: %s %v", w.Body.String(), err)
	}
	next := b.request("GET", "/v1/account/shares?cursor="+url.QueryEscape(page.NextCursor), nil)
	requireStatus(t, next, 200)
	page = share.AdminPage{}
	if err := json.Unmarshal(next.Body.Bytes(), &page); err != nil || len(page.Items) != 1 || page.NextCursor != "" {
		t.Fatalf("next page: %s %v", next.Body.String(), err)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		"status=unknown", "status=", "status=active&status=revoked", "limit=0", "limit=-1", "limit=101", "limit=x", "limit=1.0", "limit=", "limit=1&limit=2",
		"cursor=", "cursor=invalid!", "cursor=a&cursor=b", "status=revoked&cursor=" + url.QueryEscape(page.NextCursor), "other=value", "status=%GG", "status=active;limit=1",
	} {
		w := b.request("GET", "/v1/account/shares?"+query, nil)
		requireStatus(t, w, 400)
		assertShareNoStore(t, w)
	}
	for _, query := range []string{"status=all", "status=active", "status=revoked", "status=expired", "status=view_limit_exhausted", "limit=1", "limit=100"} {
		requireStatus(t, b.request("GET", "/v1/account/shares?"+query, nil), 200)
	}
	for _, id := range []string{"invalid", "00000000000000000000000000000000", uuid.NewString() + "/extra"} {
		for _, method := range []string{"GET", "DELETE"} {
			w := b.request(method, "/v1/account/shares/"+id, nil)
			requireStatus(t, w, 400)
			assertShareNoStore(t, w)
		}
	}
}

func TestAccountSharesSessionInvalidationAndDatabaseFailure(t *testing.T) {
	for _, reason := range []string{"expired", "generation", "logout", "database", "share query"} {
		t.Run(reason, func(t *testing.T) {
			s, pool := testService(t)
			b := enroll(t, s, pool)
			status := 401
			var query string
			switch reason {
			case "expired":
				query = `UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second'`
			case "generation":
				query = `UPDATE accounts SET auth_generation=auth_generation+1`
			case "logout":
				query = `DELETE FROM auth_sessions`
			case "database":
				pool.Close()
				status = 503
			case "share query":
				query = `DROP TABLE shares`
				status = 503
			}
			if query != "" {
				if _, err := pool.Exec(t.Context(), query); err != nil {
					t.Fatal(err)
				}
			}
			for _, endpoint := range []struct{ method, path string }{{"GET", "/v1/account/shares"}, {"GET", "/v1/account/shares/" + uuid.NewString()}, {"DELETE", "/v1/account/shares/" + uuid.NewString()}} {
				w := b.request(endpoint.method, endpoint.path, nil)
				requireStatus(t, w, status)
				assertShareNoStore(t, w)
			}
		})
	}
}

func TestPendingShareAdministrationCannotPassRecovery(t *testing.T) {
	for _, method := range []string{"list", "GET", "DELETE"} {
		t.Run(method, func(t *testing.T) {
			s, pool := testService(t)
			b := enroll(t, s, pool)
			ctx := t.Context()
			id := uuid.New()
			if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content) VALUES($1,$2,'private')`, id, randomBytes(32)); err != nil {
				t.Fatal(err)
			}
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			u, err := owner(ctx, tx)
			if err != nil {
				t.Fatal(err)
			}
			path, verb := "/v1/account/shares/"+id.String(), method
			if method == "list" {
				path, verb = "/v1/account/shares", "GET"
			}
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() { result <- b.request(verb, path, nil) }()
			waitForAccountLock(t, pool)
			if err := replaceCredentials(ctx, tx, u, &webauthn.Credential{ID: randomBytes(32)}, "Replacement"); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			requireStatus(t, <-result, 401)
			if n := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE revoked_at IS NOT NULL OR view_count<>0`); n != 0 {
				t.Fatal("invalidated session changed share")
			}
		})
	}
}

func TestShareRevocationHoldsAuthorizationLocksThroughCommit(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	ctx := t.Context()
	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content) VALUES($1,$2,'private')`, id, randomBytes(32)); err != nil {
		t.Fatal(err)
	}
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT id FROM shares WHERE id=$1 FOR UPDATE`, id); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- b.request("DELETE", "/v1/account/shares/"+id.String(), nil) }()
	deadline := time.Now().Add(5 * time.Second)
	locked := false
	for time.Now().Before(deadline) {
		if n := testdb.Count(t, pool, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
			AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%UPDATE shares SET revoked_at%'`); n > 0 {
			locked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !locked {
		t.Fatal("revocation did not wait on share lock")
	}
	// Neither account nor session may be unlocked while the mutation is pending.
	for _, query := range []string{`SELECT id FROM accounts FOR UPDATE NOWAIT`, `SELECT token_hash FROM auth_sessions FOR UPDATE NOWAIT`} {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, lockErr := tx.Exec(ctx, query)
		tx.Rollback(ctx)
		pgErr, ok := lockErr.(*pgconn.PgError)
		if !ok || pgErr.Code != "55P03" {
			t.Fatalf("authorization lock released early: %v", lockErr)
		}
	}
	recovery := make(chan error, 1)
	go func() {
		tx, err := pool.Begin(ctx)
		if err != nil {
			recovery <- err
			return
		}
		defer tx.Rollback(ctx)
		u, err := owner(ctx, tx)
		if err == nil {
			err = replaceCredentials(ctx, tx, u, &webauthn.Credential{ID: randomBytes(32)}, "Recovered")
		}
		if err == nil {
			err = tx.Commit(ctx)
		}
		recovery <- err
	}()
	// owner() also locks the account, but its SQL differs from lockAccount().
	deadline = time.Now().Add(5 * time.Second)
	locked = false
	for time.Now().Before(deadline) {
		if n := testdb.Count(t, pool, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
			AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM accounts ORDER BY created_at,id LIMIT 1 FOR UPDATE%'`); n > 0 {
			locked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !locked {
		t.Fatal("recovery did not wait for revocation authorization")
	}
	select {
	case err := <-recovery:
		t.Fatalf("recovery completed before revocation committed: %v", err)
	default:
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, <-result, 204)
	if err := <-recovery; err != nil {
		t.Fatal(err)
	}
	if n := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE revoked_at IS NOT NULL`); n != 1 {
		t.Fatal("revocation did not commit")
	}
	requireStatus(t, b.request("GET", "/v1/account/shares", nil), 401)
}
