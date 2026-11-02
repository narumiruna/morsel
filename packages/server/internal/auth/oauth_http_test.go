package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
)

const oauthTestScope = "mcp:shares offline_access"

type oauthTestClient struct {
	ID           string   `json:"client_id"`
	Name         string   `json:"client_name"`
	RedirectURIs []string `json:"redirect_uris"`
}

type oauthTestFlow struct {
	Client   oauthTestClient
	Redirect string
	Verifier string
	State    string
	Handle   string
	Code     string
}

type oauthTestTokens struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	Type    string `json:"token_type"`
	Scope   string `json:"scope"`
	Expires int    `json:"expires_in"`
}

func oauthHTTPRequest(s *Service, method, path, content, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if content != "" {
		r.Header.Set("Content-Type", content)
	}
	w := httptest.NewRecorder()
	s.OAuthHandler().ServeHTTP(w, r)
	return w
}

func oauthHTTPClone(form url.Values) url.Values {
	copy := make(url.Values, len(form))
	for key, values := range form {
		copy[key] = append([]string(nil), values...)
	}
	return copy
}

func oauthHTTPForm(s *Service, path string, form url.Values) *httptest.ResponseRecorder {
	return oauthHTTPRequest(s, "POST", path, "application/x-www-form-urlencoded", form.Encode())
}

func oauthHTTPStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	requireStatus(t, w, status)
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("OAuth response permits caching")
	}
}

func oauthHTTPJSON(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body == nil {
		t.Fatalf("invalid OAuth JSON: %s", w.Body.String())
	}
	return body
}

func oauthHTTPError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	oauthHTTPStatus(t, w, status)
	body := oauthHTTPJSON(t, w)
	if body["error"] == nil || body["error"] == "" || (code != "" && body["error"] != code) {
		t.Fatalf("OAuth error=%v want=%s", body, code)
	}
	if w.Header().Get("Location") != "" || body["access_token"] != nil || body["refresh_token"] != nil {
		t.Fatal("invalid protocol request returned a redirect or credential")
	}
}

func oauthHTTPPrivateError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	oauthHTTPStatus(t, w, status)
	if body := oauthHTTPJSON(t, w); code != "" && body["code"] != code {
		t.Fatalf("private OAuth error=%v want=%s", body, code)
	}
}

func oauthHTTPRegistration(redirect string) map[string]any {
	return map[string]any{
		"client_name": "Native test client", "redirect_uris": []string{redirect},
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"},
		"token_endpoint_auth_method": "none", "application_type": "native", "scope": oauthTestScope,
	}
}

func oauthHTTPRegister(t *testing.T, s *Service, redirect string) oauthTestClient {
	t.Helper()
	w := oauthHTTPRequest(s, "POST", "/oauth/register", "application/json", string(encode(t, oauthHTTPRegistration(redirect))))
	oauthHTTPStatus(t, w, 201)
	var client oauthTestClient
	if err := json.Unmarshal(w.Body.Bytes(), &client); err != nil {
		t.Fatal(err)
	}
	if id, err := uuid.Parse(client.ID); err != nil || id == uuid.Nil || client.Name != "Native test client" || !reflect.DeepEqual(client.RedirectURIs, []string{redirect}) {
		t.Fatalf("invalid registration metadata: %+v", client)
	}
	if body := oauthHTTPJSON(t, w); body["client_secret"] != nil || body["registration_access_token"] != nil {
		t.Fatal("public registration returned an unsupported secret")
	}
	return client
}

func oauthHTTPAuthorizeForm(s *Service, flow oauthTestFlow, scope string) url.Values {
	digest := sha256.Sum256([]byte(flow.Verifier))
	return url.Values{
		"response_type": {"code"}, "client_id": {flow.Client.ID}, "redirect_uri": {flow.Redirect},
		"state": {flow.State}, "code_challenge": {base64.RawURLEncoding.EncodeToString(digest[:])},
		"code_challenge_method": {"S256"}, "resource": {s.origin + "/mcp"}, "scope": {scope},
	}
}

func oauthHTTPBegin(t *testing.T, s *Service, client oauthTestClient, redirect, scope string) oauthTestFlow {
	t.Helper()
	flow := oauthTestFlow{Client: client, Redirect: redirect, Verifier: randomToken(), State: "state + / ? & = % 日本語"}
	w := oauthHTTPRequest(s, "GET", "/oauth/authorize?"+oauthHTTPAuthorizeForm(s, flow, scope).Encode(), "", "")
	oauthHTTPStatus(t, w, 302)
	location, err := url.Parse(w.Header().Get("Location"))
	if err != nil || location.Scheme+"://"+location.Host != s.origin || location.Path != "/oauth/consent" || len(location.Query()) != 1 {
		t.Fatalf("unsafe consent redirect: %s", w.Header().Get("Location"))
	}
	flow.Handle = location.Query().Get("request")
	raw, err := base64.RawURLEncoding.Strict().DecodeString(flow.Handle)
	if err != nil || len(raw) != 32 || len(flow.Handle) != 43 {
		t.Fatal("authorization request does not use a 256-bit opaque handle")
	}
	if len(w.Result().Cookies()) != 0 {
		t.Fatal("native authorization changed browser credentials")
	}
	return flow
}

func oauthHTTPRequestPath(flow oauthTestFlow) string {
	return "/v1/account/oauth/requests/" + flow.Handle
}

func oauthHTTPBind(t *testing.T, b *browser, flow oauthTestFlow) string {
	t.Helper()
	w := b.request("GET", oauthHTTPRequestPath(flow), nil)
	oauthHTTPStatus(t, w, 200)
	body := oauthHTTPJSON(t, w)
	id := body["account_id"].(string)
	if body["client_id"] != flow.Client.ID || body["client_name"] != flow.Client.Name || body["resource"] != b.s.origin+"/mcp" || body["redirect_host"] == "" || body["scope"] == nil || body["expires_at"] == nil || w.Header().Get("X-Morsel-Account-ID") != id {
		t.Fatalf("incomplete consent metadata: %v", body)
	}
	if strings.Contains(w.Body.String(), flow.Verifier) || strings.Contains(w.Body.String(), flow.State) {
		t.Fatal("consent metadata exposes protocol secrets")
	}
	return id
}

func oauthHTTPDecision(t *testing.T, b *browser, flow oauthTestFlow, accountID string, approve bool) *httptest.ResponseRecorder {
	t.Helper()
	return b.request("POST", oauthHTTPRequestPath(flow), encode(t, map[string]any{"approve": approve, "account_id": accountID}))
}

func oauthHTTPCallback(t *testing.T, s *Service, w *httptest.ResponseRecorder, flow oauthTestFlow) *url.URL {
	t.Helper()
	oauthHTTPStatus(t, w, 200)
	redirect, _ := oauthHTTPJSON(t, w)["redirect_url"].(string)
	u, err := url.Parse(redirect)
	if err != nil {
		t.Fatal(err)
	}
	base := *u
	base.RawQuery = ""
	if base.String() != flow.Redirect || u.Query().Get("state") != flow.State || u.Query().Get("iss") != s.origin || len(u.Query()["state"]) != 1 || len(u.Query()["iss"]) != 1 {
		t.Fatalf("callback lost redirect, state, or issuer binding: %s", redirect)
	}
	if strings.Contains(redirect, flow.Verifier) || u.Query().Get("access_token") != "" || u.Query().Get("refresh_token") != "" {
		t.Fatal("callback contains an access credential or verifier")
	}
	return u
}

func oauthHTTPApproved(t *testing.T, b *browser, client oauthTestClient, redirect, scope string) oauthTestFlow {
	t.Helper()
	flow := oauthHTTPBegin(t, b.s, client, redirect, scope)
	id := oauthHTTPBind(t, b, flow)
	w := oauthHTTPDecision(t, b, flow, id, true)
	u := oauthHTTPCallback(t, b.s, w, flow)
	flow.Code = u.Query().Get("code")
	oauthHTTPCredential(t, flow.Code, "moc_")
	if u.Query().Get("error") != "" || w.Header().Get("X-Morsel-Account-ID") != id {
		t.Fatal("approval omitted the account marker or returned an error")
	}
	return flow
}

func oauthHTTPCodeForm(s *Service, flow oauthTestFlow) url.Values {
	return url.Values{
		"grant_type": {"authorization_code"}, "client_id": {flow.Client.ID}, "resource": {s.origin + "/mcp"},
		"code": {flow.Code}, "redirect_uri": {flow.Redirect}, "code_verifier": {flow.Verifier},
	}
}

func oauthHTTPRefreshForm(s *Service, client oauthTestClient, refresh string) url.Values {
	return url.Values{"grant_type": {"refresh_token"}, "client_id": {client.ID}, "resource": {s.origin + "/mcp"}, "refresh_token": {refresh}}
}

func oauthHTTPCredential(t *testing.T, token, prefix string) {
	t.Helper()
	if len(token) != 47 || !strings.HasPrefix(token, prefix) {
		t.Fatalf("invalid %s credential format", prefix)
	}
	if raw, err := base64.RawURLEncoding.Strict().DecodeString(token[4:]); err != nil || len(raw) != 32 {
		t.Fatal("OAuth credential has less than 256 bits")
	}
}

func oauthHTTPAccess(t *testing.T, s *Service, token string, want uuid.UUID) {
	t.Helper()
	id, insufficient, err := s.AuthenticateMCP(t.Context(), "Bearer "+token)
	if err != nil || insufficient || id != want {
		t.Fatalf("OAuth access account=%s insufficient=%v error=%v want=%s", id, insufficient, err, want)
	}
}

func oauthHTTPReadTokens(t *testing.T, w *httptest.ResponseRecorder, offline bool) oauthTestTokens {
	t.Helper()
	oauthHTTPStatus(t, w, 200)
	var tokens oauthTestTokens
	if err := json.Unmarshal(w.Body.Bytes(), &tokens); err != nil {
		t.Fatal(err)
	}
	oauthHTTPCredential(t, tokens.Access, "moa_")
	if !strings.EqualFold(tokens.Type, "Bearer") || tokens.Expires < 1 || tokens.Expires > 600 || (tokens.Scope != "mcp:shares" && tokens.Scope != oauthTestScope) {
		t.Fatalf("invalid token metadata: type=%s expires=%d scope=%s", tokens.Type, tokens.Expires, tokens.Scope)
	}
	if offline {
		oauthHTTPCredential(t, tokens.Refresh, "mor_")
	} else if tokens.Refresh != "" {
		t.Fatal("refresh token issued without offline_access")
	}
	return tokens
}

func oauthHTTPNewService(t *testing.T, s *Service, pool *pgxpool.Pool) *Service {
	t.Helper()
	u, _ := url.Parse(s.origin)
	other, err := NewService(pool, u)
	if err != nil {
		t.Fatal(err)
	}
	return other
}

func TestOAuthHTTPMetadataAndMethods(t *testing.T) {
	s, _ := testService(t)
	for _, path := range []string{"/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"} {
		r := httptest.NewRequest("GET", "http://untrusted.example"+path, nil)
		r.Header.Set("Forwarded", "host=attacker.example;proto=https")
		r.Header.Set("X-Forwarded-Host", "attacker.example")
		w := httptest.NewRecorder()
		s.OAuthHandler().ServeHTTP(w, r)
		oauthHTTPStatus(t, w, 200)
		body := oauthHTTPJSON(t, w)
		if strings.Contains(w.Body.String(), "untrusted.example") || strings.Contains(w.Body.String(), "attacker.example") {
			t.Fatal("metadata trusts request authority")
		}
		if strings.Contains(path, "protected-resource") {
			if body["resource"] != s.origin+"/mcp" || !reflect.DeepEqual(body["authorization_servers"], []any{s.origin}) || !reflect.DeepEqual(body["scopes_supported"], []any{"mcp:shares", "offline_access"}) {
				t.Fatalf("invalid resource metadata: %v", body)
			}
		} else {
			for key, want := range map[string]any{
				"issuer": s.origin, "authorization_endpoint": s.origin + "/oauth/authorize", "token_endpoint": s.origin + "/oauth/token", "registration_endpoint": s.origin + "/oauth/register", "revocation_endpoint": s.origin + "/oauth/revoke",
				"response_types_supported": []any{"code"}, "grant_types_supported": []any{"authorization_code", "refresh_token"}, "token_endpoint_auth_methods_supported": []any{"none"}, "code_challenge_methods_supported": []any{"S256"}, "authorization_response_iss_parameter_supported": true,
			} {
				if !reflect.DeepEqual(body[key], want) {
					t.Fatalf("metadata %s=%v want=%v", key, body[key], want)
				}
			}
			if body["client_id_metadata_document_supported"] == true || body["client_id_metadata_documents_supported"] == true {
				t.Fatal("metadata advertises unsupported client metadata fetching")
			}
		}
	}
	for _, test := range []struct{ method, path, allow string }{
		{"POST", "/.well-known/oauth-protected-resource/mcp", "GET"}, {"POST", "/.well-known/oauth-authorization-server", "GET"},
		{"GET", "/oauth/register", "POST"}, {"POST", "/oauth/authorize", "GET"}, {"GET", "/oauth/token", "POST"}, {"GET", "/oauth/revoke", "POST"},
	} {
		w := oauthHTTPRequest(s, test.method, test.path, "application/json", "{}")
		oauthHTTPStatus(t, w, 405)
		if !strings.Contains(w.Header().Get("Allow"), test.allow) {
			t.Fatalf("%s omitted Allow", test.path)
		}
	}
	oauthHTTPStatus(t, oauthHTTPRequest(s, "POST", "/oauth/unknown", "application/json", "{}"), 404)
}

func TestOAuthHTTPRegistrationValidation(t *testing.T) {
	s, pool := testService(t)
	redirect := "http://127.0.0.1:49152/callback"
	for _, field := range []string{"application_type", "scope"} {
		body := oauthHTTPRegistration(redirect)
		delete(body, field)
		oauthHTTPStatus(t, oauthHTTPRequest(s, "POST", "/oauth/register", "application/json", string(encode(t, body))), 201)
	}
	for _, test := range []struct {
		name, field string
		value       any
	}{
		{"empty name", "client_name", ""}, {"long name", "client_name", strings.Repeat("a", 201)}, {"control name", "client_name", "client\nname"},
		{"missing redirect", "redirect_uris", []string{}}, {"too many redirects", "redirect_uris", []string{redirect, redirect, redirect, redirect, redirect, redirect}},
		{"secret authentication", "token_endpoint_auth_method", "client_secret_basic"}, {"implicit", "response_types", []string{"token"}},
		{"client credentials", "grant_types", []string{"client_credentials"}}, {"web application", "application_type", "web"}, {"unknown scope", "scope", "admin"},
		{"client metadata fetch", "client_uri", "http://127.0.0.1/private"},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := oauthHTTPRegistration(redirect)
			body[test.field] = test.value
			oauthHTTPError(t, oauthHTTPRequest(s, "POST", "/oauth/register", "application/json", string(encode(t, body))), 400, "")
		})
	}
	for _, redirect := range []string{
		"https://example.com/callback#fragment", "https://example.com/callback?next=evil", "https://user:password@example.com/callback", "https://*.example.com/callback",
		"http://example.com/callback", "javascript:alert(1)", "https://example.com", "https://example.com/%63allback", "http://127.0.0.1:00080/callback", "http://127.0.0.1:0/callback", "http://127.0.0.1:65536/callback",
	} {
		t.Run(redirect, func(t *testing.T) {
			oauthHTTPError(t, oauthHTTPRequest(s, "POST", "/oauth/register", "application/json", string(encode(t, oauthHTTPRegistration(redirect)))), 400, "")
		})
	}
	valid := string(encode(t, oauthHTTPRegistration(redirect)))
	for _, body := range []string{"", "null", "[]", valid + " {}", `{"client_name":"duplicate",` + valid[1:], strings.Repeat(" ", 16385) + valid} {
		oauthHTTPError(t, oauthHTTPRequest(s, "POST", "/oauth/register", "application/json", body), 400, "")
	}
	for _, content := range []string{"", "text/plain", "application/x-www-form-urlencoded"} {
		oauthHTTPError(t, oauthHTTPRequest(s, "POST", "/oauth/register", content, valid), 400, "")
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_clients`) != 2 {
		t.Fatal("invalid registration persisted a client")
	}
}

func TestOAuthHTTPAuthorizeStrictBinding(t *testing.T) {
	s, pool := testService(t)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthTestFlow{Client: client, Redirect: client.RedirectURIs[0], Verifier: randomToken(), State: "state-123456"}
	valid := oauthHTTPAuthorizeForm(s, flow, oauthTestScope)
	for _, field := range []string{"response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"} {
		t.Run("missing "+field, func(t *testing.T) {
			form := oauthHTTPClone(valid)
			form.Del(field)
			oauthHTTPError(t, oauthHTTPRequest(s, "GET", "/oauth/authorize?"+form.Encode(), "", ""), 400, "")
		})
	}
	for _, test := range []struct{ field, value string }{
		{"response_type", "token"}, {"client_id", uuid.NewString()}, {"redirect_uri", "https://evil.example/callback"},
		{"redirect_uri", "https://native.example/callback/extra"}, {"redirect_uri", "https://native.example/callback?extra=true"},
		{"state", "short"}, {"state", strings.Repeat("s", 2049)}, {"state", "state\n123456"},
		{"code_challenge_method", "plain"}, {"code_challenge_method", "s256"}, {"code_challenge", "short"}, {"code_challenge", strings.Repeat("!", 43)},
		{"resource", s.origin + "/mcp/"}, {"resource", "https://evil.example/mcp"}, {"scope", "mcp:shares admin"}, {"scope", "offline_access"}, {"scope", "mcp:shares mcp:shares"},
		{"prompt", "none"}, {"unknown", "value"},
	} {
		t.Run(test.field+" "+test.value, func(t *testing.T) {
			form := oauthHTTPClone(valid)
			form.Set(test.field, test.value)
			oauthHTTPError(t, oauthHTTPRequest(s, "GET", "/oauth/authorize?"+form.Encode(), "", ""), 400, "")
		})
	}
	for _, field := range []string{"client_id", "redirect_uri", "state", "scope", "resource", "code_challenge"} {
		form := oauthHTTPClone(valid)
		form.Add(field, form.Get(field))
		oauthHTTPError(t, oauthHTTPRequest(s, "GET", "/oauth/authorize?"+form.Encode(), "", ""), 400, "")
	}
	for _, query := range []string{valid.Encode() + "&broken=%ZZ", valid.Encode() + ";unknown=true", valid.Encode() + "&unknown=" + strings.Repeat("x", 16384)} {
		oauthHTTPError(t, oauthHTTPRequest(s, "GET", "/oauth/authorize?"+query, "", ""), 400, "")
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_requests`) != 0 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants`) != 0 {
		t.Fatal("invalid authorization stored a request or grant")
	}
	valid.Set("prompt", "consent")
	for _, state := range []string{"12345678", strings.Repeat("s", 2048)} {
		valid.Set("state", state)
		oauthHTTPStatus(t, oauthHTTPRequest(s, "GET", "/oauth/authorize?"+valid.Encode(), "", ""), 302)
	}
}

func TestOAuthHTTPLoopbackRedirectPortException(t *testing.T) {
	s, _ := testService(t)
	for _, test := range []struct {
		registered, requested string
		valid                 bool
	}{
		{"http://127.0.0.1:1234/callback", "http://127.0.0.1:5678/callback", true},
		{"http://[::1]:1234/callback", "http://[::1]:5678/callback", true},
		{"http://localhost:1234/callback", "http://localhost:5678/callback", false},
		{"https://native.example:1234/callback", "https://native.example:5678/callback", false},
		{"http://127.0.0.1:1234/callback", "http://127.0.0.1:5678/other", false},
		{"http://127.0.0.1:1234/callback", "http://127.0.0.2:5678/callback", false},
		{"http://127.0.0.1:1234/callback", "http://localhost:5678/callback", false},
		{"http://127.0.0.1:1234/callback", "https://127.0.0.1:5678/callback", false},
		{"http://127.0.0.1:1234/callback", "http://127.0.0.1:5678/callback?code=attacker", false},
		{"http://127.0.0.1:1234/callback", "http://127.0.0.1:5678/%63allback", false},
	} {
		t.Run(test.requested, func(t *testing.T) {
			client := oauthHTTPRegister(t, s, test.registered)
			flow := oauthTestFlow{Client: client, Redirect: test.requested, Verifier: randomToken(), State: "state-123456"}
			w := oauthHTTPRequest(s, "GET", "/oauth/authorize?"+oauthHTTPAuthorizeForm(s, flow, oauthTestScope).Encode(), "", "")
			if test.valid {
				oauthHTTPStatus(t, w, 302)
			} else {
				oauthHTTPError(t, w, 400, "")
			}
		})
	}
}

func TestOAuthHTTPConsentDoesNotIssueOnGETAndDenial(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "http://127.0.0.1:49152/callback")
	flow := oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
	for range 2 {
		id := oauthHTTPBind(t, b, flow)
		if id != testdb.AccountID(t, pool).String() {
			t.Fatal("consent selected a different account")
		}
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants`) != 0 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`) != 0 {
		t.Fatal("consent GET issued credentials")
	}
	// Denial never grants authority, so it does not require fresh verification.
	if _, err := pool.Exec(t.Context(), `UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '13 hours'`); err != nil {
		t.Fatal(err)
	}
	id := testdb.AccountID(t, pool).String()
	u := oauthHTTPCallback(t, s, oauthHTTPDecision(t, b, flow, id, false), flow)
	if u.Query().Get("error") != "access_denied" || u.Query().Get("code") != "" || len(u.Query()) != 3 {
		t.Fatal("denial returned a credential or lost state/issuer")
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants`) != 0 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`) != 0 {
		t.Fatal("denial issued credentials")
	}
	if _, err := pool.Exec(t.Context(), `UPDATE auth_sessions SET verified_at=clock_timestamp()`); err != nil {
		t.Fatal(err)
	}
	oauthHTTPPrivateError(t, b.request("GET", oauthHTTPRequestPath(flow), nil), 409, "oauth_request_invalid")
	oauthHTTPPrivateError(t, oauthHTTPDecision(t, b, flow, id, true), 409, "oauth_request_invalid")
}

func TestOAuthHTTPConsentAuthorizationAndFreshVerification(t *testing.T) {
	s, pool := testService(t)
	b, authenticator := enrollAuthenticator(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
	id := testdb.AccountID(t, pool).String()
	oauthHTTPPrivateError(t, newBrowser(s).request("GET", oauthHTTPRequestPath(flow), nil), 401, "")
	oauthHTTPPrivateError(t, oauthHTTPDecision(t, b, flow, id, true), 409, "oauth_request_invalid")
	oauthHTTPBind(t, b, flow)
	for _, test := range []struct{ origin, csrf string }{
		{"", b.csrf}, {"https://evil.example", b.csrf}, {s.origin, ""}, {s.origin, "wrong"},
	} {
		r := httptest.NewRequest("POST", oauthHTTPRequestPath(flow), bytes.NewReader(encode(t, map[string]any{"approve": true, "account_id": id})))
		r.Header.Set("Origin", test.origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", test.csrf)
		r.AddCookie(b.cookies[sessionCookie])
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		oauthHTTPStatus(t, w, 403)
	}
	for _, body := range []string{
		`{}`, `{"approve":true}`, `{"approve":true,"account_id":"invalid"}`, `{"account_id":"` + id + `"}`, `{"approve":"true","account_id":"` + id + `"}`,
		`{"approve":true,"account_id":"` + id + `","extra":true}`, `{"approve":false,"approve":true,"account_id":"` + id + `"}`,
	} {
		oauthHTTPPrivateError(t, b.request("POST", oauthHTTPRequestPath(flow), []byte(body)), 400, "")
	}
	oauthHTTPPrivateError(t, oauthHTTPDecision(t, b, flow, uuid.NewString(), true), 409, "oauth_request_invalid")
	if _, err := pool.Exec(t.Context(), `UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '13 hours'`); err != nil {
		t.Fatal(err)
	}
	oauthHTTPBind(t, b, flow)
	oauthHTTPPrivateError(t, oauthHTTPDecision(t, b, flow, id, true), 403, "verification_required")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`) != 0 {
		t.Fatal("stale verification issued a code")
	}
	verify(t, b, authenticator)
	w := oauthHTTPDecision(t, b, flow, id, true)
	oauthHTTPCredential(t, oauthHTTPCallback(t, s, w, flow).Query().Get("code"), "moc_")
	oauthHTTPPrivateError(t, oauthHTTPDecision(t, b, flow, id, true), 409, "oauth_request_invalid")
}

func TestOAuthHTTPConsentRejectsChangedSessionAccountAndExpiry(t *testing.T) {
	for _, change := range []string{"same account new session", "different account", "expired request", "logout"} {
		t.Run(change, func(t *testing.T) {
			s, pool := testService(t)
			b, a := enrollAuthenticator(t, s, pool)
			client := oauthHTTPRegister(t, s, "https://native.example/callback")
			flow := oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
			id := oauthHTTPBind(t, b, flow)
			current := b
			switch change {
			case "same account new session":
				current = loginAuthenticator(t, s, a)
			case "different account":
				current, _ = inviteAuthenticator(t, s, pool, "Other account")
			case "expired request":
				if _, err := pool.Exec(t.Context(), `UPDATE oauth_requests SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
					t.Fatal(err)
				}
			case "logout":
				requireStatus(t, b.request("POST", "/v1/auth/logout", []byte(`{}`)), 204)
				current = loginAuthenticator(t, s, a)
			}
			oauthHTTPPrivateError(t, current.request("GET", oauthHTTPRequestPath(flow), nil), 409, "oauth_request_invalid")
			oauthHTTPPrivateError(t, oauthHTTPDecision(t, current, flow, id, true), 409, "oauth_request_invalid")
			if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`) != 0 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants`) != 0 {
				t.Fatal("invalid consent minted credentials")
			}
		})
	}
}

func TestOAuthHTTPCodeBindingAndWrongVerifierRollback(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "http://127.0.0.1:1234/callback")
	other := oauthHTTPRegister(t, s, "http://127.0.0.1:1234/callback")
	flow := oauthHTTPApproved(t, b, client, "http://127.0.0.1:5678/callback", oauthTestScope)
	valid := oauthHTTPCodeForm(s, flow)
	for _, test := range []struct{ field, value string }{
		{"code_verifier", randomToken()}, {"code_verifier", "short"}, {"client_id", other.ID}, {"redirect_uri", client.RedirectURIs[0]},
		{"resource", "https://evil.example/mcp"}, {"scope", "mcp:shares admin"},
	} {
		form := oauthHTTPClone(valid)
		form.Set(test.field, test.value)
		w := oauthHTTPForm(s, "/oauth/token", form)
		oauthHTTPError(t, w, 400, "")
		if strings.Contains(w.Body.String(), flow.Code) || strings.Contains(w.Body.String(), flow.Verifier) {
			t.Fatal("failed exchange reflected a credential")
		}
		if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='code' AND active`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='pkce' AND active`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind IN ('access','refresh')`) != 0 {
			t.Fatal("failed exchange consumed code or PKCE state")
		}
	}
	for _, field := range []string{"resource", "code_verifier", "redirect_uri", "client_id"} {
		form := oauthHTTPClone(valid)
		form.Del(field)
		oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", form), 400, "")
	}
	tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", valid), true)
	if tokens.Scope != oauthTestScope {
		t.Fatal("exchange lost requested permissions")
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='code' AND active`) != 0 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='pkce'`) != 0 {
		t.Fatal("successful exchange did not consume code and PKCE state")
	}
	// A different registered client must not turn replay into family revocation.
	wrongClient := oauthHTTPClone(valid)
	wrongClient.Set("client_id", other.ID)
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", wrongClient), 400, "invalid_grant")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 0 {
		t.Fatal("foreign client revoked a family by replaying its code")
	}
	oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, tokens.Refresh)), true)
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", valid), 400, "invalid_grant")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE active`) != 0 {
		t.Fatal("code replay did not revoke the whole grant family")
	}
}

func TestOAuthHTTPRefreshRotationReplayAndClientBinding(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	other := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	valid := oauthHTTPRefreshForm(s, client, tokens.Refresh)
	for _, test := range []struct{ field, value string }{{"resource", "https://evil.example/mcp"}, {"client_id", other.ID}, {"scope", "mcp:shares admin"}} {
		form := oauthHTTPClone(valid)
		form.Set(test.field, test.value)
		oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", form), 400, "")
	}
	// This profile requires an exact scope set. It must reject unsupported
	// downscoping, not silently return the original broader permission set.
	narrowed := oauthHTTPClone(valid)
	narrowed.Set("scope", "mcp:shares")
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", narrowed), 400, "invalid_scope")
	missingResource := oauthHTTPClone(valid)
	missingResource.Del("resource")
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", missingResource), 400, "")
	rotated := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", valid), true)
	if rotated.Access == tokens.Access || rotated.Refresh == tokens.Refresh {
		t.Fatal("refresh rotation reused credentials")
	}
	foreignReplay := oauthHTTPClone(valid)
	foreignReplay.Set("client_id", other.ID)
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", foreignReplay), 400, "invalid_grant")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 0 {
		t.Fatal("foreign refresh replay revoked another client's family")
	}
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", valid), 400, "invalid_grant")
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, rotated.Refresh)), 400, "invalid_grant")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE active`) != 0 {
		t.Fatal("refresh reuse did not revoke access tokens and the family")
	}
}

func TestOAuthHTTPNoOfflineAccessAndNoScopeWidening(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], "mcp:shares")
	form := oauthHTTPCodeForm(s, flow)
	form.Set("scope", oauthTestScope)
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", form), 400, "")
	form.Set("scope", "mcp:shares")
	tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", form), false)
	if tokens.Scope != "mcp:shares" || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='refresh'`) != 0 {
		t.Fatal("token response widened scope or granted persistent access")
	}
}

func TestOAuthHTTPProtocolFormsAndCredentialTypes(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	valid := oauthHTTPCodeForm(s, flow)
	for _, field := range []string{"grant_type", "client_id", "resource", "code", "redirect_uri", "code_verifier"} {
		form := oauthHTTPClone(valid)
		form.Add(field, form.Get(field))
		oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", form), 400, "")
	}
	for _, body := range []string{valid.Encode() + "&unknown=value", valid.Encode() + "&bad=%ZZ", valid.Encode() + "&padding=" + strings.Repeat("x", 16384)} {
		oauthHTTPError(t, oauthHTTPRequest(s, "POST", "/oauth/token", "application/x-www-form-urlencoded", body), 400, "")
	}
	for _, content := range []string{"", "application/json", "text/plain", "multipart/form-data", "application/x-www-form-urlencoded; charset=iso-8859-1"} {
		oauthHTTPError(t, oauthHTTPRequest(s, "POST", "/oauth/token", content, valid.Encode()), 400, "")
	}
	oauthHTTPError(t, oauthHTTPRequest(s, "POST", "/oauth/token?client_id="+client.ID, "application/x-www-form-urlencoded", valid.Encode()), 400, "")
	for _, grant := range []string{"client_credentials", "password", "implicit"} {
		form := oauthHTTPClone(valid)
		form.Set("grant_type", grant)
		oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", form), 400, "")
	}
	for _, token := range []string{b.cookies[sessionCookie].Value, "msk_" + randomToken(), "moa_" + randomToken(), "mor_" + randomToken(), "moc_" + randomToken() + "=", "moc_" + strings.Repeat("A", 42) + "B"} {
		form := oauthHTTPClone(valid)
		form.Set("code", token)
		oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", form), 400, "invalid_grant")
	}
	// Browser cookies never replace protocol client/resource/PKCE fields.
	r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(valid.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: "untrusted-cookie"})
	w := httptest.NewRecorder()
	s.OAuthHandler().ServeHTTP(w, r)
	tokens := oauthHTTPReadTokens(t, w, true)
	oauthHTTPAccess(t, s, flow.Code, uuid.Nil)
	oauthHTTPAccess(t, s, tokens.Refresh, uuid.Nil)
	for _, token := range []string{flow.Code, tokens.Access, b.cookies[sessionCookie].Value} {
		oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, token)), 400, "invalid_grant")
	}
	for _, token := range []string{flow.Code, tokens.Access, tokens.Refresh} {
		if id, err := s.Authenticate(t.Context(), "Bearer "+token); err != nil || id != uuid.Nil {
			t.Fatal("OAuth credential acquired legacy REST authority")
		}
		r := httptest.NewRequest("GET", "/v1/account/oauth/grants", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		oauthHTTPStatus(t, w, 401)
	}
}

func TestOAuthHTTPNativeOriginPolicy(t *testing.T) {
	s, _ := testService(t)
	body := string(encode(t, oauthHTTPRegistration("http://127.0.0.1:1234/callback")))
	for _, origins := range [][]string{nil, {s.origin}, {"https://evil.example"}, {s.origin, s.origin}, {"null"}, {s.origin + "/"}} {
		r := httptest.NewRequest("POST", "/oauth/register", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		for _, origin := range origins {
			r.Header.Add("Origin", origin)
		}
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: "ignored"})
		w := httptest.NewRecorder()
		s.OAuthHandler().ServeHTTP(w, r)
		if len(origins) == 0 || len(origins) == 1 && origins[0] == s.origin {
			oauthHTTPStatus(t, w, 201)
		} else {
			oauthHTTPError(t, w, 403, "")
		}
		if len(w.Result().Cookies()) != 0 || w.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Fatal("protocol endpoint uses browser-cookie authority")
		}
	}
}

func TestOAuthHTTPRevocationClientAndFamilyBinding(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	other := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	for _, form := range []url.Values{
		{"token": {tokens.Refresh}, "client_id": {other.ID}}, {"token": {"mor_" + randomToken()}, "client_id": {client.ID}},
	} {
		w := oauthHTTPForm(s, "/oauth/revoke", form)
		oauthHTTPStatus(t, w, 200)
		if len(oauthHTTPJSON(t, w)) != 0 {
			t.Fatal("revocation reveals unknown or foreign credentials")
		}
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 0 {
		t.Fatal("foreign client revoked the grant family")
	}
	rotated := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, tokens.Refresh)), true)
	for _, token := range []string{tokens.Refresh, rotated.Access} {
		w := oauthHTTPForm(s, "/oauth/revoke", url.Values{"token": {token}, "client_id": {client.ID}, "token_type_hint": {"refresh_token"}})
		oauthHTTPStatus(t, w, 200)
		if len(oauthHTTPJSON(t, w)) != 0 {
			t.Fatal("revocation must return an empty object")
		}
	}
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, rotated.Refresh)), 400, "invalid_grant")
	oauthHTTPAccess(t, s, tokens.Access, uuid.Nil)
	oauthHTTPAccess(t, s, rotated.Access, uuid.Nil)
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 1 {
		t.Fatal("revocation did not revoke the grant family")
	}
	for _, form := range []url.Values{
		{"token": {"unknown"}}, {"client_id": {client.ID}}, {"token": {"unknown", "duplicate"}, "client_id": {client.ID}},
		{"token": {"unknown"}, "client_id": {client.ID}, "unexpected": {"value"}},
	} {
		oauthHTTPError(t, oauthHTTPForm(s, "/oauth/revoke", form), 400, "")
	}
}

func TestOAuthHTTPAccountOwnedGrantManagement(t *testing.T) {
	s, pool := testService(t)
	first, _ := enrollAuthenticator(t, s, pool)
	second, _ := inviteAuthenticator(t, s, pool, "Second")
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	tokens := make(map[*browser]oauthTestTokens)
	for _, b := range []*browser{first, second} {
		flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
		tokens[b] = oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	}
	ids := make(map[*browser]string)
	for _, b := range []*browser{first, second} {
		w := b.request("GET", "/v1/account/oauth/grants", nil)
		oauthHTTPStatus(t, w, 200)
		var grants []map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &grants); err != nil || len(grants) != 1 {
			t.Fatalf("wrong account grant list: %s", w.Body.String())
		}
		if grants[0]["client_id"] != client.ID || grants[0]["client_name"] != client.Name || grants[0]["resource"] != s.origin+"/mcp" || grants[0]["scope"] != oauthTestScope || w.Header().Get("X-Morsel-Account-ID") != b.state(t)["account_id"] {
			t.Fatal("grant metadata or account marker does not match the session")
		}
		ids[b], _ = grants[0]["id"].(string)
		if _, err := uuid.Parse(ids[b]); err != nil || strings.Contains(w.Body.String(), "signature") || strings.Contains(w.Body.String(), "request_data") {
			t.Fatal("invalid or unsafe grant metadata")
		}
	}
	if ids[first] == ids[second] {
		t.Fatal("two accounts share a grant family")
	}
	for _, id := range []string{ids[second], uuid.NewString()} {
		oauthHTTPPrivateError(t, first.request("DELETE", "/v1/account/oauth/grants/"+id, nil), 404, "")
	}
	if _, err := pool.Exec(t.Context(), `UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '13 hours' WHERE token_hash=$1`, hashToken(first.cookies[sessionCookie].Value)); err != nil {
		t.Fatal(err)
	}
	oauthHTTPPrivateError(t, first.request("DELETE", "/v1/account/oauth/grants/"+ids[first], nil), 403, "verification_required")
	if _, err := pool.Exec(t.Context(), `UPDATE auth_sessions SET verified_at=clock_timestamp() WHERE token_hash=$1`, hashToken(first.cookies[sessionCookie].Value)); err != nil {
		t.Fatal(err)
	}
	csrf := first.csrf
	first.csrf = "wrong"
	oauthHTTPStatus(t, first.request("DELETE", "/v1/account/oauth/grants/"+ids[first], nil), 403)
	first.csrf = csrf
	w := first.request("DELETE", "/v1/account/oauth/grants/"+ids[first], nil)
	oauthHTTPStatus(t, w, 204)
	if w.Body.Len() != 0 || w.Header().Get("X-Morsel-Account-ID") != first.state(t)["account_id"] {
		t.Fatal("grant revocation lost its account marker or returned content")
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE id=$1 AND revoked_at IS NOT NULL`, ids[first]) != 1 {
		t.Fatal("account revocation affected the wrong family")
	}
	oauthHTTPAccess(t, s, tokens[first].Access, uuid.Nil)
	oauthHTTPAccess(t, s, tokens[second].Access, uuid.MustParse(second.state(t)["account_id"].(string)))
}

func TestOAuthHTTPCredentialStorageAndLifetimes(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	var codeExpiry, familyExpiry, clientExpiry time.Time
	if err := pool.QueryRow(t.Context(), `SELECT t.expires_at,g.expires_at,c.expires_at FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id JOIN oauth_clients c ON c.id=g.client_id WHERE t.kind='code'`).Scan(&codeExpiry, &familyExpiry, &clientExpiry); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		expires time.Time
		want    time.Duration
	}{{codeExpiry, time.Minute}, {familyExpiry, 30 * 24 * time.Hour}, {clientExpiry, 90 * 24 * time.Hour}} {
		if delta := time.Until(test.expires) - test.want; delta < -5*time.Second || delta > 5*time.Second {
			t.Fatalf("credential lifetime=%s want=%s", time.Until(test.expires), test.want)
		}
	}
	// Keep the family near its absolute end; refresh must not slide the deadline.
	if _, err := pool.Exec(t.Context(), `UPDATE oauth_grants SET expires_at=clock_timestamp()+interval '5 minutes'`); err != nil {
		t.Fatal(err)
	}
	tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	rotated := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, tokens.Refresh)), true)
	if tokens.Expires > 300 || rotated.Expires > 300 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.expires_at>g.expires_at`) != 0 {
		t.Fatal("token lifetime exceeds the absolute family deadline")
	}
	for _, token := range []string{flow.Code, tokens.Access, tokens.Refresh, rotated.Access, rotated.Refresh} {
		digest := sha256.Sum256([]byte(token))
		if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE signature=$1`, hex.EncodeToString(digest[:])) != 1 {
			t.Fatal("credential is not stored by its SHA-256 signature")
		}
	}
	var stored string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_object('clients',(SELECT jsonb_agg(to_jsonb(c)) FROM oauth_clients c),'requests',(SELECT jsonb_agg(to_jsonb(r)) FROM oauth_requests r),'grants',(SELECT jsonb_agg(to_jsonb(g)) FROM oauth_grants g),'tokens',(SELECT jsonb_agg(to_jsonb(t)) FROM oauth_tokens t))::text`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{flow.Code, flow.Verifier, flow.Handle, tokens.Access, tokens.Refresh, rotated.Access, rotated.Refresh} {
		if strings.Contains(stored, secret) {
			t.Fatal("OAuth storage retains a raw credential, handle, or PKCE verifier")
		}
	}
	if _, err := pool.Exec(t.Context(), `UPDATE oauth_grants SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, rotated.Refresh)), 400, "invalid_grant")
}

func TestOAuthHTTPExpiredCodeDoesNotExchange(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	if _, err := pool.Exec(t.Context(), `UPDATE oauth_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE kind IN ('code','pkce')`); err != nil {
		t.Fatal(err)
	}
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), 400, "invalid_grant")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind IN ('access','refresh')`) != 0 {
		t.Fatal("expired authorization code issued credentials")
	}
}

func TestOAuthHTTPMultiServicePersistenceAndLogout(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	other := oauthHTTPNewService(t, s, pool)
	b.s = other
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	requireStatus(t, b.request("POST", "/v1/auth/logout", []byte(`{}`)), 204)
	rotated := oauthHTTPReadTokens(t, oauthHTTPForm(other, "/oauth/token", oauthHTTPRefreshForm(other, client, tokens.Refresh)), true)
	oauthHTTPStatus(t, oauthHTTPForm(s, "/oauth/revoke", url.Values{"client_id": {client.ID}, "token": {rotated.Refresh}}), 200)
	restarted := oauthHTTPNewService(t, s, pool)
	oauthHTTPError(t, oauthHTTPForm(restarted, "/oauth/token", oauthHTTPRefreshForm(restarted, client, rotated.Refresh)), 400, "invalid_grant")
}

func TestOAuthHTTPProtocolRateLimitsIgnoreForwardedAddresses(t *testing.T) {
	s, _ := testService(t)
	for i := range 61 {
		r := httptest.NewRequest("POST", "/oauth/register", strings.NewReader("{}"))
		r.RemoteAddr = fmt.Sprintf("192.0.2.1:%d", 1000+i)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", i))
		r.Header.Set("Forwarded", fmt.Sprintf("for=198.51.100.%d", i))
		w := httptest.NewRecorder()
		s.OAuthHandler().ServeHTTP(w, r)
		if i < 60 {
			oauthHTTPError(t, w, 400, "")
		} else {
			oauthHTTPError(t, w, 429, "")
			if w.Header().Get("Retry-After") != "60" {
				t.Fatal("rate limit omitted bounded retry delay")
			}
		}
	}
	// Fixed endpoint kinds have independent per-IP buckets.
	r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader("grant_type=unknown"))
	r.RemoteAddr = "192.0.2.1:9999"
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	s.OAuthHandler().ServeHTTP(w, r)
	oauthHTTPError(t, w, 400, "")
	// Invalid client-controlled paths must not allocate a new kind per path.
	for i := range 70 {
		w := oauthHTTPRequest(s, "POST", fmt.Sprintf("/oauth/unknown-%d", i), "application/json", "{}")
		if w.Code != 404 && w.Code != 429 {
			t.Fatalf("unknown OAuth route status=%d", w.Code)
		}
	}
}

func TestOAuthHTTPProtocolGlobalRateLimit(t *testing.T) {
	s, _ := testService(t)
	for i := range 1001 {
		r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader("grant_type=unknown"))
		r.RemoteAddr = fmt.Sprintf("192.0.2.%d:1234", i/60+1)
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		s.OAuthHandler().ServeHTTP(w, r)
		if i < 1000 {
			oauthHTTPError(t, w, 400, "")
		} else {
			oauthHTTPError(t, w, 429, "")
		}
	}
}

func TestOAuthHTTPStorageFailuresAreSafe(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	pool.Close()
	for _, test := range []struct{ method, path, content, body string }{
		{"POST", "/oauth/register", "application/json", string(encode(t, oauthHTTPRegistration(client.RedirectURIs[0])))},
		{"GET", "/oauth/authorize?" + oauthHTTPAuthorizeForm(s, flow, oauthTestScope).Encode(), "", ""},
		{"POST", "/oauth/token", "application/x-www-form-urlencoded", oauthHTTPCodeForm(s, flow).Encode()},
		{"POST", "/oauth/revoke", "application/x-www-form-urlencoded", url.Values{"token": {"mor_" + randomToken()}, "client_id": {client.ID}}.Encode()},
	} {
		w := oauthHTTPRequest(s, test.method, test.path, test.content, test.body)
		oauthHTTPError(t, w, 503, "")
		for _, internal := range []string{"closed pool", "postgres", "SELECT", "oauth_tokens", flow.Code, flow.Verifier} {
			if strings.Contains(w.Body.String(), internal) {
				t.Fatal("storage failure exposed internal details or credentials")
			}
		}
	}
	for _, path := range []string{"/v1/account/oauth/grants", oauthHTTPRequestPath(flow)} {
		w := b.request("GET", path, nil)
		oauthHTTPStatus(t, w, 503)
		if strings.Contains(w.Body.String(), "closed pool") {
			t.Fatal("private OAuth endpoint exposed storage failure")
		}
	}
}

func TestOAuthHTTPDiscoveryCORSAndStrictQueries(t *testing.T) {
	s, _ := testService(t)
	for _, path := range []string{"/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"} {
		for _, method := range []string{"GET", "OPTIONS"} {
			r := httptest.NewRequest(method, path, nil)
			r.Header.Set("Origin", "https://native.example")
			r.Header.Set("Access-Control-Request-Method", "GET")
			w := httptest.NewRecorder()
			s.OAuthHandler().ServeHTTP(w, r)
			status := 200
			if method == "OPTIONS" {
				status = 204
			}
			oauthHTTPStatus(t, w, status)
			if w.Header().Get("Access-Control-Allow-Origin") != "*" || w.Header().Get("Access-Control-Allow-Credentials") != "" || len(w.Result().Cookies()) != 0 {
				t.Fatal("discovery CORS permits browser credentials")
			}
		}
		oauthHTTPError(t, oauthHTTPRequest(s, "GET", path+"?unknown=true", "", ""), 400, "invalid_request")
	}
	oauthHTTPStatus(t, oauthHTTPRequest(s, "GET", "/oauth/unknown", "", ""), 404)
}

func TestOAuthHTTPConsentHandleBindingAndBounds(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
	for _, handle := range []string{"short", randomToken(), strings.Repeat("A", 42) + "B", flow.Handle + "=", flow.Handle + "?approve=true"} {
		oauthHTTPPrivateError(t, b.request("GET", "/v1/account/oauth/requests/"+handle, nil), 409, "oauth_request_invalid")
	}
	id := oauthHTTPBind(t, b, flow)
	var storedHash, sessionHash []byte
	var generation int64
	var expires time.Time
	if err := pool.QueryRow(t.Context(), `SELECT handle_hash,session_hash,generation,expires_at FROM oauth_requests WHERE account_id=$1`, id).Scan(&storedHash, &sessionHash, &generation, &expires); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(storedHash, hashToken(flow.Handle)) || !bytes.Equal(sessionHash, hashToken(b.cookies[sessionCookie].Value)) || generation != 1 || time.Until(expires) < 9*time.Minute || time.Until(expires) > 10*time.Minute {
		t.Fatal("request handle, session, generation, or ten-minute deadline is not bound")
	}
	oauthHTTPPrivateError(t, b.request("GET", "/v1/account/oauth/grants?unexpected=true", nil), 400, "")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants`) != 0 {
		t.Fatal("invalid or preview consent GET issued a grant")
	}
}

func TestOAuthHTTPNeverFetchesRegisteredCallbacks(t *testing.T) {
	var calls atomic.Int32
	callback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(500)
	}))
	defer callback.Close()
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, callback.URL+"/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	if calls.Load() != 0 {
		t.Fatal("OAuth service fetched a client-controlled callback")
	}
}

func TestOAuthHTTPRecoveryIsAccountLocalAndPreservesLegacyKeys(t *testing.T) {
	s, pool := testService(t)
	first := enroll(t, s, pool)
	second, _ := inviteAuthenticator(t, s, pool, "Second")
	firstID := uuid.MustParse(first.state(t)["account_id"].(string))
	secondID := uuid.MustParse(second.state(t)["account_id"].(string))
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	issued := make(map[*browser]oauthTestTokens)
	for _, b := range []*browser{first, second} {
		flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
		issued[b] = oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	}
	unusedCode := oauthHTTPApproved(t, first, client, client.RedirectURIs[0], oauthTestScope)
	pending := oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
	oauthHTTPBind(t, first, pending)
	w := first.request("POST", "/v1/api-keys", []byte(`{"name":"Retained"}`))
	requireStatus(t, w, 201)
	key, _ := oauthHTTPJSON(t, w)["key"].(string)
	token, err := IssueGrant(t.Context(), pool, "recover", firstID)
	if err != nil {
		t.Fatal(err)
	}
	recovered := newBrowser(s)
	w = recovered.request("POST", "/v1/auth/recover/begin", encode(t, map[string]string{"token": token, "name": "Replacement"}))
	requireStatus(t, w, 200)
	replacement := newAuthenticator(t)
	requireStatus(t, recovered.request("POST", "/v1/auth/recover/finish", replacement.registration(t, w.Body.Bytes(), s.origin, true)), 200)
	if recovered.state(t)["account_id"] != firstID.String() {
		t.Fatal("recovery selected another account")
	}
	oauthHTTPAccess(t, s, issued[first].Access, uuid.Nil)
	oauthHTTPAccess(t, s, issued[second].Access, secondID)
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, issued[first].Refresh)), 400, "invalid_grant")
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, unusedCode)), 400, "invalid_grant")
	oauthHTTPPrivateError(t, recovered.request("GET", oauthHTTPRequestPath(pending), nil), 409, "oauth_request_invalid")
	oauthHTTPPrivateError(t, oauthHTTPDecision(t, recovered, pending, firstID.String(), true), 409, "oauth_request_invalid")
	oauthHTTPStatus(t, first.request("GET", "/v1/account/oauth/grants", nil), 401)
	if id, err := s.Authenticate(t.Context(), "Bearer "+key); err != nil || id != firstID {
		t.Fatal("OAuth recovery changed a legacy API key")
	}
	oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, issued[second].Refresh)), true)
	flow := oauthHTTPApproved(t, recovered, client, client.RedirectURIs[0], oauthTestScope)
	tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	oauthHTTPAccess(t, s, tokens.Access, firstID)
}
