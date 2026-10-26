package auth

import (
	"github.com/google/uuid"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/narumiruna/morsel/packages/server/internal/testdb"
)

func TestExtendedSessionLifetimeDoesNotSlide(t *testing.T) {
	s, pool := testService(t)
	b, a := enrollAuthenticator(t, s, pool)
	ctx := t.Context()
	var expires time.Time
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM auth_sessions`).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	if remaining := time.Until(expires); remaining < 30*24*time.Hour-time.Minute || remaining > 30*24*time.Hour+time.Minute {
		t.Fatalf("session remaining lifetime=%s", remaining)
	}
	if b.state(t)["verification_required"] != false {
		t.Fatal("new session must reuse its login verification")
	}
	verify(t, b, a)
	var after time.Time
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM auth_sessions`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !after.Equal(expires) {
		t.Fatal("verification extended the absolute session expiry")
	}

	// A previously issued session keeps its stored shorter lifetime.
	if err := pool.QueryRow(ctx, `UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '6 hours' RETURNING expires_at`).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, b.request("GET", "/v1/account", nil), 200)
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM auth_sessions`).Scan(&after); err != nil || !after.Equal(expires) {
		t.Fatal("reading state changed a previously issued session expiry")
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	state := b.state(t)
	if state["authenticated"] != false || state["verification_required"] != nil || state["csrf_token"] != nil {
		t.Fatal("expired session exposed authorization state")
	}
	requireStatus(t, b.request("POST", "/v1/api-keys", []byte(`{"name":"Expired"}`)), 401)
}

func TestVerificationReuseAndExpiry(t *testing.T) {
	s, pool := testService(t)
	b, a := enrollAuthenticator(t, s, pool)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '11 hours'`); err != nil {
		t.Fatal(err)
	}
	if b.state(t)["verification_required"] != false {
		t.Fatal("verification expired before twelve hours")
	}
	for _, name := range []string{"First", "Second"} {
		requireStatus(t, b.request("POST", "/v1/api-keys", encode(t, map[string]string{"name": name})), 201)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '12 hours 1 second'`); err != nil {
		t.Fatal(err)
	}
	if b.state(t)["verification_required"] != true {
		t.Fatal("old verification accepted")
	}
	requireStatus(t, b.request("POST", "/v1/api-keys", []byte(`{"name":"Blocked"}`)), 403)
	if testdb.Count(t, pool, `SELECT count(*) FROM api_keys`) != 2 {
		t.Fatal("expired verification caused a write")
	}
	verify(t, b, a)
	if b.state(t)["verification_required"] != false {
		t.Fatal("fresh verification state not updated")
	}
	requireStatus(t, b.request("POST", "/v1/api-keys", []byte(`{"name":"Allowed"}`)), 201)
}

func TestExtendedGrantAndFlowLifetimes(t *testing.T) {
	s, pool := testService(t)
	token, err := IssueGrant(t.Context(), pool, "setup", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	var expires time.Time
	if err := pool.QueryRow(t.Context(), `SELECT expires_at FROM auth_grants`).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	if remaining := time.Until(expires); remaining < time.Hour-time.Minute || remaining > time.Hour+time.Minute {
		t.Fatalf("grant remaining lifetime=%s", remaining)
	}
	b := newBrowser(s)
	w := b.request("POST", "/v1/auth/setup/begin", encode(t, map[string]string{"token": token}))
	requireStatus(t, w, 200)
	if timeout := challenge(t, w.Body.Bytes())["timeout"]; timeout != float64((10 * time.Minute).Milliseconds()) {
		t.Fatalf("WebAuthn timeout=%v", timeout)
	}
	if err := pool.QueryRow(t.Context(), `SELECT expires_at FROM auth_flows`).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	if remaining := time.Until(expires); remaining < 9*time.Minute || remaining > 11*time.Minute {
		t.Fatalf("flow remaining lifetime=%s", remaining)
	}
}

func TestSessionCookiePersistenceAndRemoval(t *testing.T) {
	s := &Service{secure: true}
	for _, name := range []string{sessionCookie, flowCookie} {
		w := httptest.NewRecorder()
		s.cookie(w, name, "opaque-token", false)
		cookie := w.Result().Cookies()[0]
		if name == sessionCookie {
			if cookie.MaxAge != 30*24*60*60 || time.Until(cookie.Expires) < 29*24*time.Hour {
				t.Fatal("session cookie is not persistent for thirty days")
			}
		} else if cookie.MaxAge != 0 || !cookie.Expires.IsZero() {
			t.Fatal("flow cookie became persistent")
		}
		w = httptest.NewRecorder()
		s.cookie(w, name, "", true)
		removed := w.Result().Cookies()[0]
		if removed.MaxAge != -1 || !removed.Expires.Before(time.Now()) || removed.Value != "" {
			t.Fatal("cookie removal did not override persistence")
		}
	}
}
