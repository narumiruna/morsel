package api

import (
	"bytes"
	"crypto/sha256"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/packages/server/internal/auth"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
)

func TestAccountShareRoutesPreserveAuthenticationBoundaries(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	origin, _ := url.Parse("http://localhost:5173")
	account, err := auth.NewService(pool, origin)
	if err != nil {
		t.Fatal(err)
	}
	accountID := uuid.New()
	const sessionToken = "private-browser-session"
	const csrf = "private-csrf"
	sessionHash, keyHash := sha256.Sum256([]byte(sessionToken)), sha256.Sum256([]byte(testAPIKey))
	if _, err := pool.Exec(ctx, `INSERT INTO accounts(id) VALUES($1)`, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at)
		VALUES($1,$2,1,$3,clock_timestamp()+interval '1 day')`, sessionHash[:], accountID, csrf); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO api_keys(id,account_id,name,prefix,token_hash) VALUES($1,$2,'CLI','prefix',$3)`, uuid.New(), accountID, keyHash[:]); err != nil {
		t.Fatal(err)
	}
	repository := share.NewPostgresRepository(pool)
	capability, capabilityHash, err := (share.TokenGenerator{}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.New()
	if _, err := repository.Create(ctx, share.CreateParams{AccountID: testdb.AccountID(t, pool), ID: id, TokenHash: capabilityHash, LinkToken: capability, Content: "private Markdown"}); err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	handler := NewRouter(NewService(repository, share.TokenGenerator{}, origin, 100, logger), RouterConfig{
		Authenticator: account, Account: account, MaxRequestBody: 1024, RequestTimeout: time.Second, Logger: logger,
	})
	perform := func(method, path string, session, bearer bool) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Origin", origin.String())
		r.Header.Set("X-CSRF-Token", csrf)
		if session {
			r.AddCookie(&http.Cookie{Name: "morsel_session", Value: sessionToken})
		}
		if bearer {
			r.Header.Set("Authorization", "Bearer "+testAPIKey)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	path := "/v1/account/shares/" + id.String()
	for _, endpoint := range []struct{ method, path string }{{"GET", "/v1/account/shares"}, {"GET", path}, {"GET", path + "/link"}, {"DELETE", path}} {
		for _, bearer := range []bool{false, true} {
			w := perform(endpoint.method, endpoint.path, false, bearer)
			if w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("browser boundary: %d %s", w.Code, w.Body.String())
			}
		}
	}
	// A browser session must not replace Bearer authorization on old routes.
	for _, endpoint := range []struct{ method, path string }{{"POST", "/v1/shares"}, {"DELETE", "/v1/shares/" + id.String()}} {
		if w := perform(endpoint.method, endpoint.path, true, false); w.Code != 401 {
			t.Fatalf("session authorized old write route: %d %s", w.Code, w.Body.String())
		}
	}
	for _, endpoint := range []struct{ method, path string }{{"GET", "/v1/account/shares?limit=1"}, {"GET", path}} {
		w := perform(endpoint.method, endpoint.path, true, false)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "token_hash") || strings.Contains(w.Body.String(), "link_token") || strings.Contains(w.Body.String(), capability) {
			t.Fatalf("management route: %d %s", w.Code, w.Body.String())
		}
	}
	if w := perform("GET", path+"/link", true, false); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), capability) {
		t.Fatalf("stored link retrieval: %d %s", w.Code, w.Body.String())
	}
	if n := testdb.Count(t, pool, `SELECT view_count FROM shares WHERE id=$1`, id); n != 0 {
		t.Fatal("management consumed a view")
	}
	if w := perform("GET", "/v1/shares/"+capability, false, false); w.Code != 200 {
		t.Fatalf("public read changed: %d %s", w.Code, w.Body.String())
	}
	for range 2 {
		if w := perform("DELETE", path, true, false); w.Code != 204 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("management revocation: %d %s", w.Code, w.Body.String())
		}
	}
	if w := perform("GET", "/v1/shares/"+capability, false, false); w.Code != 410 {
		t.Fatalf("revoked public capability: %d %s", w.Code, w.Body.String())
	}
	// Bearer revocation still uses its original route and authorization.
	if w := perform("DELETE", "/v1/shares/"+id.String(), false, true); w.Code != 204 {
		t.Fatalf("Bearer revocation changed: %d %s", w.Code, w.Body.String())
	}
	for _, route := range []string{`"route":"/v1/account/shares"`, `"route":"/v1/account/shares/{id}"`} {
		if !strings.Contains(logs.String(), route) {
			t.Fatalf("missing route template %s: %s", route, logs.String())
		}
	}
	for _, secret := range []string{sessionToken, csrf, capability, testAPIKey, "private Markdown", "?limit="} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("management log exposed %q", secret)
		}
	}
}
