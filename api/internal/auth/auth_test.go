package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func testService(t *testing.T) (*Service, *pgxpool.Pool) {
	t.Helper()
	pool := testdb.Open(t)
	u, _ := url.Parse("http://localhost:5173")
	s, err := NewService(pool, u)
	if err != nil {
		t.Fatal(err)
	}
	return s, pool
}
func TestConfiguration(t *testing.T) {
	for _, test := range []struct {
		raw, rp, origin string
		secure, valid   bool
	}{
		{"https://morsel.example:8443/path", "morsel.example", "https://morsel.example:8443", true, true},
		{"https://Morsel.Example:443", "morsel.example", "https://morsel.example", true, true},
		{"http://LOCALHOST:80", "localhost", "http://localhost", false, true},
		{"https://Morsel.Example:8443", "morsel.example", "https://morsel.example:8443", true, true},
		{"http://localhost:5173", "localhost", "http://localhost:5173", false, true},
		{"http://example.com", "", "", false, false},
		{"http://127.0.0.1:5173", "", "", false, false},
		{"https://user@example.com", "", "", false, false},
		{"https://example.com?x=1", "", "", false, false},
	} {
		t.Run(test.raw, func(t *testing.T) {
			u, _ := url.Parse(test.raw)
			s, err := NewService(&pgxpool.Pool{}, u)
			if (err == nil) != test.valid {
				t.Fatalf("NewService error=%v", err)
			}
			if err != nil {
				return
			}
			if s.web.Config.RPID != test.rp || s.origin != test.origin || s.secure != test.secure {
				t.Fatalf("incorrect derived configuration: %+v", s)
			}
			w := httptest.NewRecorder()
			s.cookie(w, sessionCookie, "token", false)
			c := w.Result().Cookies()[0]
			if c.Domain != "" || c.Path != "/" || !c.HttpOnly || c.Secure != test.secure || c.SameSite != http.SameSiteLaxMode || c.MaxAge != 30*24*60*60 || c.Expires.Before(time.Now().Add(sessionLifetime-time.Minute)) || c.Expires.After(time.Now().Add(sessionLifetime+time.Minute)) {
				t.Fatalf("unsafe cookie: %+v", c)
			}
		})
	}
	if _, err := NewService(nil, nil); err == nil {
		t.Fatal("accepted nil config")
	}
}
func TestRateLimiterBounded(t *testing.T) {
	var l rateLimiter
	now := time.Now()
	for i := 0; i < 60; i++ {
		if !l.allow("127.0.0.1:1234", "login", now) {
			t.Fatal("limited early")
		}
	}
	if l.allow("127.0.0.1:9999", "login", now) {
		t.Fatal("source port bypassed limit")
	}
	if !l.allow("127.0.0.1:1", "login", now.Add(time.Minute)) {
		t.Fatal("window not reset")
	}
	// Even a full client map cannot grow beyond the fixed bound.
	l.clients = make(map[string]rateBucket)
	for i := 0; i < 4096; i++ {
		l.clients[string(rune(i))] = rateBucket{start: now}
	}
	if l.allow("new-client", "login", now) {
		t.Fatal("accepted new client with full map")
	}
	if len(l.clients) != 4096 {
		t.Fatal("unbounded client map")
	}
}
func TestRequestGuards(t *testing.T) {
	s := &Service{origin: "http://localhost:5173"}
	for _, test := range []struct {
		origin, content, body string
		status                int
	}{
		{"", "application/json", "{}", 403},
		{"http://localhost:5174", "application/json", "{}", 403},
		{"https://localhost:5173", "application/json", "{}", 403},
		{"http://evil.example", "application/json", "{}", 403},
		{"http://localhost:5173", "text/plain", "{}", 400},
	} {
		r := httptest.NewRequest("POST", "/v1/auth/login/begin", strings.NewReader(test.body))
		r.Header.Set("Origin", test.origin)
		r.Header.Set("Content-Type", test.content)
		r.Header.Set("X-Forwarded-For", "trusted")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != test.status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("got %d %s", w.Code, w.Body.String())
		}
		var e map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil || e["code"] == "" || e["message"] == "" {
			t.Fatal("unstable error response")
		}
	}
}
func TestJSONBoundsAndNames(t *testing.T) {
	for _, body := range []string{"", `{} {}`, `{"unexpected":1}`, `null true`, `{"name":`} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		var v struct {
			Name string `json:"name"`
		}
		if err := decodeJSON(r, &v); err == nil {
			t.Fatalf("accepted %s", body)
		}
	}
	for _, name := range []string{"", strings.Repeat("a", 201), "a\nb", "a\x00b"} {
		if _, err := cleanName(name); err == nil {
			t.Fatalf("accepted name %q", name)
		}
	}
}

type browser struct {
	s       *Service
	cookies map[string]*http.Cookie
	csrf    string
}

func newBrowser(s *Service) *browser { return &browser{s: s, cookies: make(map[string]*http.Cookie)} }
func (b *browser) request(method, path string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.Header.Set("Origin", b.s.origin)
	r.Header.Set("Content-Type", "application/json")
	if b.csrf != "" {
		r.Header.Set("X-CSRF-Token", b.csrf)
	}
	for _, c := range b.cookies {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	b.s.ServeHTTP(w, r)
	for _, c := range w.Result().Cookies() {
		if c.MaxAge < 0 {
			delete(b.cookies, c.Name)
		} else {
			b.cookies[c.Name] = c
		}
	}
	return w
}
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status=%d want=%d body=%s", w.Code, status, w.Body.String())
	}
}
func (b *browser) state(t *testing.T) map[string]any {
	t.Helper()
	w := b.request("GET", "/v1/account", nil)
	requireStatus(t, w, 200)
	var v map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	b.csrf, _ = v["csrf_token"].(string)
	return v
}
func TestGrantStorageAndSingleUse(t *testing.T) {
	s, pool := testService(t)
	ctx := context.Background()
	token, err := IssueGrant(ctx, pool, "setup")
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != 43 {
		t.Fatal("grant entropy too short")
	}
	var stored []byte
	if err = pool.QueryRow(ctx, `SELECT token_hash FROM auth_grants`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, hashToken(token)) || bytes.Contains(stored, []byte(token)) {
		t.Fatal("grant not hash only")
	}
	replacement, err := IssueGrant(ctx, pool, "setup")
	if err != nil {
		t.Fatal(err)
	}
	if replacement == token || testdb.Count(t, pool, `SELECT count(*) FROM auth_grants`) != 1 {
		t.Fatal("grant replacement failed")
	}
	b := newBrowser(s)
	requireStatus(t, b.request("POST", "/v1/auth/setup/begin", []byte(`{"token":"`+token+`"}`)), 403)
	requireStatus(t, b.request("POST", "/v1/auth/setup/begin", []byte(`{"token":"`+replacement+`"}`)), 200)
	requireStatus(t, b.request("POST", "/v1/auth/setup/finish", []byte(`{}`)), 400)
	requireStatus(t, b.request("POST", "/v1/auth/setup/finish", []byte(`{}`)), 400)
	if _, err = IssueGrant(ctx, pool, "wrong"); err == nil {
		t.Fatal("accepted invalid grant kind")
	}
	if _, err = IssueGrant(ctx, pool, "recover"); err == nil {
		t.Fatal("issued recovery before setup")
	}
}
func TestConcurrentLastPasskeyDeletion(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	addPasskey(t, b, "Backup")
	w := b.request("GET", "/v1/passkeys", nil)
	requireStatus(t, w, 200)
	var keys []passkeyMetadata
	_ = json.Unmarshal(w.Body.Bytes(), &keys)
	if len(keys) != 2 {
		t.Fatal("missing backup")
	}
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for _, k := range keys {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			client := newBrowser(s)
			client.csrf = b.csrf
			client.cookies[sessionCookie] = b.cookies[sessionCookie]
			results <- client.request("DELETE", "/v1/passkeys/"+id, nil).Code
		}(k.ID)
	}
	wg.Wait()
	close(results)
	statuses := map[int]int{}
	for status := range results {
		statuses[status]++
	}
	if statuses[204] != 1 || statuses[409] != 1 || testdb.Count(t, pool, `SELECT count(*) FROM passkey_credentials`) != 1 {
		t.Fatalf("incorrect deletion results: %v", statuses)
	}
}
