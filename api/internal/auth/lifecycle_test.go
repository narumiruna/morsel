package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestAccountAndAPIKeyLifecycle(t *testing.T) {
	s, pool := testService(t)
	ctx := t.Context()
	anonymous := newBrowser(s)
	if state := anonymous.state(t); state["setup_required"] != true || state["authenticated"] != false || state["csrf_token"] != nil {
		t.Fatal(state)
	}
	for _, path := range []string{"/v1/api-keys", "/v1/passkeys"} {
		requireStatus(t, anonymous.request("GET", path, nil), 401)
	}
	b, a := enrollAuthenticator(t, s, pool)
	if _, err := IssueGrant(ctx, pool, "setup"); err == nil {
		t.Fatal("setup reopened")
	}
	requireStatus(t, anonymous.request("POST", "/v1/auth/setup/begin", []byte(`{"token":"invalid"}`)), 409)
	oldCSRF := b.csrf
	b.csrf = "wrong"
	requireStatus(t, b.request("POST", "/v1/api-keys", []byte(`{"name":"test"}`)), 403)
	b.csrf = oldCSRF
	// Key creation requires recent verification even when the session is active.
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET verified_at=clock_timestamp()-make_interval(secs => $1)`, verifyLifetime.Seconds()+1); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, b.request("POST", "/v1/api-keys", []byte(`{"name":"test"}`)), 403)
	requireStatus(t, b.request("POST", "/v1/auth/passkey/begin", []byte(`{}`)), 403)
	verify(t, b, a)
	w := b.request("POST", "/v1/api-keys", []byte(`{"name":"CLI"}`))
	requireStatus(t, w, 201)
	var created struct {
		keyMetadata
		Key string `json:"key"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Key == "" || len(created.Key) != 47 || created.Name != "CLI" || created.RevokedAt != nil {
		t.Fatalf("invalid created key %+v", created)
	}
	var hash []byte
	var prefix string
	if err := pool.QueryRow(ctx, `SELECT token_hash,prefix FROM api_keys WHERE id=$1`, created.ID).Scan(&hash, &prefix); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(hash, hashToken(created.Key)) || prefix != created.Prefix || strings.Contains(prefix, created.Key) {
		t.Fatal("key not safely stored")
	}
	for _, test := range []struct {
		header string
		valid  bool
	}{{"Bearer " + created.Key, true}, {"bearer " + created.Key, false}, {"Bearer invalid", false}, {"Bearer " + created.Key + " extra", false}, {"Bearer " + strings.Repeat("a", 32), false}, {"", false}} {
		got, err := s.Valid(ctx, test.header)
		if err != nil || got != test.valid {
			t.Fatalf("Valid=%v err=%v want=%v", got, err, test.valid)
		}
	}
	// A Bearer token is not sufficient for account management.
	r := httptest.NewRequest("GET", "/v1/api-keys", nil)
	r.Header.Set("Authorization", "Bearer "+created.Key)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	requireStatus(t, rec, 401)
	w = b.request("GET", "/v1/api-keys", nil)
	requireStatus(t, w, 200)
	if bytes.Contains(w.Body.Bytes(), []byte(created.Key)) || bytes.Contains(w.Body.Bytes(), []byte("token_hash")) || bytes.Contains(w.Body.Bytes(), []byte("CreatedAt")) {
		t.Fatal("key metadata leaks or wrong JSON case")
	}
	for i := 0; i < 2; i++ {
		requireStatus(t, b.request("DELETE", "/v1/api-keys/"+created.ID, nil), 204)
	}
	valid, err := s.Valid(ctx, "Bearer "+created.Key)
	if err != nil || valid {
		t.Fatal("revoked key accepted")
	}
	requireStatus(t, b.request("DELETE", "/v1/api-keys/"+uuid.NewString(), nil), 204)
	backup := addPasskey(t, b, "Backup")
	w = b.request("GET", "/v1/passkeys", nil)
	requireStatus(t, w, 200)
	if !bytes.Contains(w.Body.Bytes(), []byte(`"name":"Backup"`)) {
		t.Fatal("flow lost name")
	}
	requireStatus(t, b.request("POST", "/v1/auth/logout", []byte(`{}`)), 204)
	if b.state(t)["authenticated"] != false {
		t.Fatal("logout did not remove session")
	}
	requireStatus(t, b.request("POST", "/v1/api-keys", []byte(`{"name":"after logout"}`)), 401)
	w = b.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	options := challenge(t, w.Body.Bytes())
	if _, present := options["allowCredentials"]; present && len(options["allowCredentials"].([]any)) != 0 {
		t.Fatal("login is not discoverable")
	}
	assertion := backup.assertion(t, w.Body.Bytes(), s.origin, true)
	requireStatus(t, b.request("POST", "/v1/auth/login/finish", assertion), 200)
	if b.state(t)["authenticated"] != true {
		t.Fatal("login did not establish session")
	}
	requireStatus(t, b.request("POST", "/v1/auth/login/finish", assertion), 400)
	// Stored session expiry must be checked again, not inferred from the cookie.
	if _, err = pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if b.state(t)["authenticated"] != false {
		t.Fatal("expired session accepted")
	}
}

func TestWebAuthnFailurePaths(t *testing.T) {
	for _, test := range []struct {
		name, origin string
		uv           bool
	}{{"wrong origin", "http://localhost:5174", true}, {"missing UV", "http://localhost:5173", false}} {
		t.Run(test.name, func(t *testing.T) {
			s, pool := testService(t)
			token, err := IssueGrant(t.Context(), pool, "setup")
			if err != nil {
				t.Fatal(err)
			}
			b := newBrowser(s)
			w := b.request("POST", "/v1/auth/setup/begin", encode(t, map[string]string{"token": token}))
			requireStatus(t, w, 200)
			a := newAuthenticator(t)
			body := a.registration(t, w.Body.Bytes(), test.origin, test.uv)
			requireStatus(t, b.request("POST", "/v1/auth/setup/finish", body), 400)
			if testdb.Count(t, pool, `SELECT count(*) FROM accounts`) != 0 {
				t.Fatal("invalid registration created account")
			}
			// Failure consumes the browser-bound challenge, but not the operator grant.
			requireStatus(t, b.request("POST", "/v1/auth/setup/finish", body), 400)
			requireStatus(t, b.request("POST", "/v1/auth/setup/begin", encode(t, map[string]string{"token": token})), 200)
		})
	}
	s, pool := testService(t)
	b, a := enrollAuthenticator(t, s, pool)
	for _, test := range []struct {
		name, origin string
		uv           bool
	}{{"wrong origin", "http://localhost:5174", true}, {"missing UV", s.origin, false}} {
		w := b.request("POST", "/v1/auth/login/begin", []byte(`{}`))
		requireStatus(t, w, 200)
		body := a.assertion(t, w.Body.Bytes(), test.origin, test.uv)
		requireStatus(t, b.request("POST", "/v1/auth/login/finish", body), 400)
	}
	// Valid credential JSON without the flow cookie does not identify a ceremony.
	w := b.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	assertion := a.assertion(t, w.Body.Bytes(), s.origin, true)
	other := newBrowser(s)
	requireStatus(t, other.request("POST", "/v1/auth/login/finish", assertion), 400)
	requireStatus(t, b.request("POST", "/v1/auth/verify/finish", assertion), 400)
	requireStatus(t, b.request("POST", "/v1/auth/login/finish", assertion), 200)
	// Grant, flow, and session expiry are database-enforced.
	token, err := IssueGrant(t.Context(), pool, "recover")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(t.Context(), `UPDATE auth_grants SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, other.request("POST", "/v1/auth/recover/begin", encode(t, map[string]string{"token": token})), 403)
	w = other.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	if _, err = pool.Exec(t.Context(), `UPDATE auth_flows SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, other.request("POST", "/v1/auth/login/finish", a.assertion(t, w.Body.Bytes(), s.origin, true)), 400)
	// JSON body limits apply to library parsing, not only our begin parser.
	w = other.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	requireStatus(t, other.request("POST", "/v1/auth/login/finish", []byte(`{"padding":"`+strings.Repeat("x", 70*1024)+`"}`)), 400)
}

func TestConcurrentSetupAndFlowFinish(t *testing.T) {
	s, pool := testService(t)
	token, err := IssueGrant(t.Context(), pool, "setup")
	if err != nil {
		t.Fatal(err)
	}
	clients := []*browser{newBrowser(s), newBrowser(s)}
	bodies := make([][]byte, 2)
	for i, b := range clients {
		w := b.request("POST", "/v1/auth/setup/begin", encode(t, map[string]string{"token": token}))
		requireStatus(t, w, 200)
		bodies[i] = newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
	}
	var wg sync.WaitGroup
	statuses := make(chan *httptest.ResponseRecorder, 2)
	for i, b := range clients {
		wg.Add(1)
		go func(i int, b *browser) {
			defer wg.Done()
			statuses <- b.request("POST", "/v1/auth/setup/finish", bodies[i])
		}(i, b)
	}
	wg.Wait()
	close(statuses)
	result := map[int]int{}
	for response := range statuses {
		result[response.Code]++
		if response.Code != 200 {
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if !(response.Code == 400 && body["code"] == "invalid_flow") && !(response.Code == 409 && body["code"] == "setup_closed") {
				t.Fatalf("unexpected setup failure: %d %s", response.Code, response.Body.String())
			}
		}
	}
	if result[200] != 1 || result[409]+result[400] != 1 || testdb.Count(t, pool, `SELECT count(*) FROM accounts`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM passkey_credentials`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE kind='setup'`) != 0 {
		t.Fatalf("concurrent setup results %v", result)
	}
	// At most one caller can consume an existing flow, independently of success.
	b := newBrowser(s)
	requireStatus(t, b.request("POST", "/v1/auth/login/begin", []byte(`{}`)), 200)
	flowToken := b.cookies[flowCookie].Value
	var wins int
	var mu sync.Mutex
	wg = sync.WaitGroup{}
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := s.consumeFlow(t.Context(), flowToken, "login"); e == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("flow consumed %d times", wins)
	}
}

func TestRecoveryInvalidatesPendingFlowsAndSessions(t *testing.T) {
	s, pool := testService(t)
	b, a := enrollAuthenticator(t, s, pool)
	ctx := t.Context()
	w := b.request("POST", "/v1/api-keys", []byte(`{"name":"survives recovery"}`))
	requireStatus(t, w, 201)
	var k struct {
		Key string `json:"key"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &k)
	login := newBrowser(s)
	w = login.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	assertion := a.assertion(t, w.Body.Bytes(), s.origin, true)
	w = b.request("POST", "/v1/auth/passkey/begin", []byte(`{"name":"stale backup"}`))
	requireStatus(t, w, 200)
	backupBody := newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
	// Consume pending flows before recovery: these represent requests already in
	// flight. Recovery must still reject their saved generation at completion.
	pendingLogin, err := s.consumeFlow(ctx, login.cookies[flowCookie].Value, "login")
	if err != nil {
		t.Fatal(err)
	}
	pendingPasskey, err := s.consumeFlow(ctx, b.cookies[flowCookie].Value, "passkey")
	if err != nil {
		t.Fatal(err)
	}
	token, err := IssueGrant(ctx, pool, "recover")
	if err != nil {
		t.Fatal(err)
	}
	recovery := newBrowser(s)
	w = recovery.request("POST", "/v1/auth/recover/begin", encode(t, map[string]string{"token": token, "name": "Replacement"}))
	requireStatus(t, w, 200)
	replacement := newAuthenticator(t)
	body := replacement.registration(t, w.Body.Bytes(), s.origin, true)
	requireStatus(t, recovery.request("POST", "/v1/auth/recover/finish", body), 200)
	requireStatus(t, recovery.request("POST", "/v1/auth/recover/finish", body), 400)
	requireStatus(t, newBrowser(s).request("POST", "/v1/auth/recover/begin", encode(t, map[string]string{"token": token})), 403)
	for _, pending := range []*flow{pendingLogin, pendingPasskey} {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, err = lockAccount(ctx, tx, pending.AccountID, pending.Generation)
		_ = tx.Rollback(ctx)
		if err != errGeneration {
			t.Fatalf("old flow authorized: %v", err)
		}
	}
	requireStatus(t, login.request("POST", "/v1/auth/login/finish", assertion), 400)
	requireStatus(t, b.request("POST", "/v1/auth/passkey/finish", backupBody), 400)
	requireStatus(t, b.request("POST", "/v1/api-keys", []byte(`{"name":"old session"}`)), 401)
	if b.state(t)["authenticated"] != false {
		t.Fatal("old session still valid")
	}
	if recovery.state(t)["authenticated"] != true {
		t.Fatal("recovery did not create new session")
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM passkey_credentials`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM accounts WHERE auth_generation=2`) != 1 {
		t.Fatal("replacement or generation failed")
	}
	valid, err := s.Valid(ctx, "Bearer "+k.Key)
	if err != nil || !valid {
		t.Fatal("recovery revoked API key")
	}
	verify(t, recovery, replacement)
	// The removed credential cannot log in, even with a new valid challenge.
	w = login.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	requireStatus(t, login.request("POST", "/v1/auth/login/finish", a.assertion(t, w.Body.Bytes(), s.origin, true)), 400)
}

func TestRecoveryRaceWithSessionMutation(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	u, err := owner(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	// Hold the account lock as recovery does. The old session remains visible to
	// a second transaction, but it must not authorize after the lock is released.
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- b.request("POST", "/v1/api-keys", []byte(`{"name":"must not commit"}`)) }()
	waitForAccountLock(t, pool)
	c := newAuthenticator(t)
	if err = replaceCredentials(ctx, tx, u, &webauthn.Credential{ID: c.id}, "Recovered"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, <-result, 401)
	if testdb.Count(t, pool, `SELECT count(*) FROM api_keys`) != 0 {
		t.Fatal("old session committed after recovery")
	}
}

func waitForAccountLock(t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		err := pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%auth_generation FROM accounts WHERE id=%'`).Scan(&count)
		if err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("request did not wait on account lock")
}
