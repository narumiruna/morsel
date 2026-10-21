package auth

import (
	"bytes"
	"net/http/httptest"
	"testing"

	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestCleanupIsBoundedAndPreservesLiveRecords(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	ctx := t.Context()
	_ = b
	var id string
	if err := pool.QueryRow(ctx, `SELECT id FROM accounts`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO auth_flows(token_hash,kind,account_id,generation,name,session_data,expires_at) SELECT sha256(convert_to('flow-'||n::text,'UTF8')),'login',$1,1,'test','{}',clock_timestamp()-interval '1 minute' FROM generate_series(1,2101) n`,
		`INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at) SELECT sha256(convert_to('session-'||n::text,'UTF8')),$1,1,'csrf',clock_timestamp()-interval '1 minute' FROM generate_series(1,2101) n`,
		`INSERT INTO auth_grants(token_hash,kind,account_id,generation,expires_at) SELECT sha256(convert_to('grant-'||n::text,'UTF8')),'recover',$1,1,clock_timestamp()-interval '1 minute' FROM generate_series(1,2101) n`,
	} {
		if _, err := pool.Exec(ctx, query, id); err != nil {
			t.Fatal(err)
		}
	}
	s.cleanupAt.Store(0)
	s.cleanup(ctx)
	for _, table := range []string{"auth_flows", "auth_sessions", "auth_grants"} {
		if n := testdb.Count(t, pool, `SELECT count(*) FROM `+table+` WHERE expires_at<clock_timestamp()`); n != 101 {
			t.Fatalf("%s expired remainder=%d", table, n)
		}
	}
	s.cleanup(ctx)
	if n := testdb.Count(t, pool, `SELECT count(*) FROM auth_flows WHERE expires_at<clock_timestamp()`); n != 101 {
		t.Fatal("cleanup not throttled")
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM auth_sessions WHERE expires_at>clock_timestamp()`) != 1 {
		t.Fatal("cleanup deleted live session")
	}
	s.cleanupAt.Store(0)
	s.cleanup(ctx)
	for _, table := range []string{"auth_flows", "auth_sessions", "auth_grants"} {
		if n := testdb.Count(t, pool, `SELECT count(*) FROM `+table+` WHERE expires_at<clock_timestamp()`); n != 0 {
			t.Fatalf("%s expired remainder=%d", table, n)
		}
	}
}

func TestDatabaseFailureIsClosed(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	pool.Close()
	valid, err := s.Valid(t.Context(), "Bearer "+randomToken())
	if valid || err == nil {
		t.Fatal("database failure authorized API key")
	}
	for _, path := range []string{"/v1/account", "/v1/api-keys", "/v1/passkeys"} {
		w := b.request("GET", path, nil)
		requireStatus(t, w, 503)
		if bytes.Contains(w.Body.Bytes(), []byte(`"authenticated":true`)) {
			t.Fatal("database failure reported authentication success")
		}
	}
}

func TestSessionGenerationAndVerificationBinding(t *testing.T) {
	s, pool := testService(t)
	first, a := enrollAuthenticator(t, s, pool)
	second := newBrowser(s)
	w := second.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	requireStatus(t, second.request("POST", "/v1/auth/login/finish", a.assertion(t, w.Body.Bytes(), s.origin, true)), 200)
	second.state(t)
	csrf := first.csrf
	first.csrf = second.csrf
	requireStatus(t, first.request("POST", "/v1/api-keys", []byte(`{"name":"wrong session CSRF"}`)), 403)
	first.csrf = csrf
	w = first.request("POST", "/v1/auth/verify/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	assertion := a.assertion(t, w.Body.Bytes(), s.origin, true)
	// The flow cookie alone cannot step up a different session on the same owner.
	second.cookies[flowCookie] = first.cookies[flowCookie]
	requireStatus(t, second.request("POST", "/v1/auth/verify/finish", assertion), 401)
	if _, err := pool.Exec(t.Context(), `UPDATE accounts SET auth_generation=auth_generation+1`); err != nil {
		t.Fatal(err)
	}
	if first.state(t)["authenticated"] != false {
		t.Fatal("stale generation accepted")
	}
}

func TestCredentialJSONRejectsTrailingValues(t *testing.T) {
	s, pool := testService(t)
	b, a := enrollAuthenticator(t, s, pool)
	w := b.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	assertion := append(a.assertion(t, w.Body.Bytes(), s.origin, true), []byte(` {}`)...)
	requireStatus(t, b.request("POST", "/v1/auth/login/finish", assertion), 400)
	if testdb.Count(t, pool, `SELECT count(*) FROM auth_sessions`) != 1 {
		t.Fatal("trailing JSON created session")
	}
}

func TestForwardedHeadersCannotBypassRateLimit(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	// Normal UI reads must not deplete authentication attempts.
	for i := 0; i < 100; i++ {
		requireStatus(t, b.request("GET", "/v1/account", nil), 200)
	}
	for i := 0; i < 65; i++ {
		r := httptest.NewRequest("POST", "/v1/auth/login/begin", bytes.NewReader([]byte(`{}`)))
		r.Header.Set("Origin", s.origin)
		r.Header.Set("Content-Type", "application/json")
		// Same source address as the browser, irrespective of proxy-supplied headers.
		r.Header.Set("X-Forwarded-For", randomToken())
		r.Header.Set("Forwarded", "for="+randomToken())
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if i < 60 {
			requireStatus(t, w, 200)
		} else {
			requireStatus(t, w, 429)
			if w.Header().Get("Retry-After") == "" {
				t.Fatal("missing retry guidance")
			}
		}
	}
	// Login floods behind a shared proxy do not spend verify or recovery budgets.
	requireStatus(t, b.request("POST", "/v1/auth/verify/begin", []byte(`{}`)), 200)
	token, err := IssueGrant(t.Context(), pool, "recover")
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, newBrowser(s).request("POST", "/v1/auth/recover/begin", encode(t, map[string]string{"token": token})), 200)
	if len(s.limiter.clients) != 4 {
		t.Fatalf("unexpected limiter client cardinality %d", len(s.limiter.clients))
	}
}
