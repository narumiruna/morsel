package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
	"github.com/narumiruna/morsel/packages/server/internal/auth"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
	"github.com/narumiruna/morsel/packages/server/internal/viewer"
	"golang.org/x/oauth2"
)

const mcpOAuthScope = "mcp:shares offline_access"

func TestMCPOAuthSDKToolsAndCompatibility(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2025-06-18", "2025-03-26"} {
		t.Run(version, func(t *testing.T) {
			f := mcpOAuthOpen(t)
			sdk := f.sdk(t, 0, true, nil)
			session := sdk.connect(t, version)
			mcpOAuthTools(t, session)
			mcpOAuthExerciseTools(t, f, session, f.accounts[0].id)
			sdk.requireDiscovery(t)

			// Legacy API keys still use the same SDK transport and all three tools.
			legacy := f.legacyConnect(t, version, 1)
			mcpOAuthTools(t, legacy)
			mcpOAuthExerciseTools(t, f, legacy, f.accounts[1].id)

			// REST-created capabilities can be read by OAuth, but not revoked by
			// a different account. Identity headers cannot select their owner.
			created := f.restCreate(t, 1, "REST capability")
			data, failed := mcpOAuthCall(t, session, "get_share", map[string]any{"token": mcpOAuthCapability(t, f, created)})
			var read Share
			mcpOAuthJSON(t, data, &read)
			if failed || read.Content != "REST capability" || read.ViewCount != 1 {
				t.Fatal("OAuth did not consume the REST capability")
			}
			foreign, failed := mcpOAuthCall(t, session, "revoke_share", map[string]any{"id": created.Id.String()})
			mcpOAuthToolError(t, foreign, failed, ErrorCodeNotFound)
			missing, failed := mcpOAuthCall(t, session, "revoke_share", map[string]any{"id": uuid.NewString()})
			mcpOAuthToolError(t, missing, failed, ErrorCodeNotFound)
			if !bytes.Equal(foreign, missing) {
				t.Fatal("OAuth distinguishes foreign and missing shares")
			}
			mcpOAuthStatus(t, f.do(t, http.MethodDelete, "/v1/shares/"+created.Id.String(), "", f.bearer(f.accounts[1].key)), http.StatusNoContent)

			data, failed = mcpOAuthCall(t, session, "create_share", map[string]any{"content": "OAuth capability"})
			mcpOAuthSuccess(t, data, failed, &created)
			capability := mcpOAuthCapability(t, f, created)
			r := f.do(t, http.MethodGet, "/v1/shares/"+capability, "", nil)
			mcpOAuthStatus(t, r, http.StatusOK)
			mcpOAuthJSON(t, r.body, &read)
			if read.Content != "OAuth capability" || read.ViewCount != 1 {
				t.Fatal("REST did not consume the OAuth capability")
			}
			mcpOAuthNoIdentity(t, r.body, r.header, f)
			mcpOAuthStatus(t, f.do(t, http.MethodDelete, "/v1/shares/"+created.Id.String(), "", f.bearer(f.accounts[0].key)), http.StatusNoContent)
		})
	}
}

func TestMCPOAuthSDKExpiryRefreshAndRestart(t *testing.T) {
	f := mcpOAuthOpen(t)
	sdk := f.sdk(t, 0, true, nil)
	session := sdk.connect(t, "2025-11-25")
	source := sdk.tokenSource(t)
	first := source.snapshot()
	// The unconfigured SDK/oauth2 refresh omits resource and must fail without
	// consuming the valid refresh credential. The configured client below is
	// the explicitly tested profile, not a claim of default SDK compatibility.
	expired := first
	expired.Expiry = time.Now().Add(-time.Minute)
	plainContext := context.WithValue(t.Context(), oauth2.HTTPClient, f.http)
	_, refreshErr := source.cfg.TokenSource(plainContext, &expired).Token()
	var rejected *oauth2.RetrieveError
	if !errors.As(refreshErr, &rejected) || rejected.Response.StatusCode != http.StatusBadRequest || rejected.ErrorCode != "invalid_request" {
		t.Fatal("default SDK refresh without resource was not rejected")
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE signature=$1 AND kind='refresh' AND active`, mcpOAuthSignature(first.RefreshToken)) != 1 {
		t.Fatal("missing-resource refresh consumed its credential")
	}
	var familyExpiry time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT g.expires_at FROM oauth_grants g JOIN oauth_tokens t ON t.grant_id=g.id WHERE t.signature=$1 AND t.kind='access'`, mcpOAuthSignature(first.AccessToken)).Scan(&familyExpiry); err != nil {
		t.Fatal("read OAuth family expiry failed")
	}

	f.expireAccess(t, source)
	mcpOAuthStatus(t, f.raw(t, first.AccessToken, "create_share", map[string]any{"content": "expired must not write"}), http.StatusUnauthorized)
	mcpOAuthTools(t, session) // The SDK's real oauth2.TokenSource performs refresh.
	second := source.snapshot()
	mcpOAuthRotated(t, first, second)
	if sdk.authorizations.Load() != 1 || sdk.trace.count("refresh_token") != 1 {
		t.Fatal("access expiry opened consent instead of refreshing once")
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE signature=$1 AND kind='refresh' AND NOT active`, mcpOAuthSignature(first.RefreshToken)) != 1 {
		t.Fatal("refresh did not retain the consumed token tombstone")
	}
	mcpOAuthStatus(t, f.raw(t, first.AccessToken, "create_share", map[string]any{"content": "rotated must not write"}), http.StatusUnauthorized)
	if err := session.Close(); err != nil {
		t.Fatal("close SDK session failed")
	}

	// Rebuild the actual application services on the same PostgreSQL pool and
	// listener. The configured issuer/resource and port do not change.
	origin := f.origin.String()
	f.restart(t)
	if f.origin.String() != origin {
		t.Fatal("restart changed the issuer")
	}
	reconnected := f.sdk(t, 0, true, source)
	reconnectedSession := reconnected.connect(t, "2025-06-18")
	mcpOAuthTools(t, reconnectedSession)
	if reconnected.authorizations.Load() != 0 || reconnected.trace.count("POST /oauth/register") != 0 {
		t.Fatal("reconnect discarded valid client credentials")
	}
	f.expireAccess(t, source)
	mcpOAuthExerciseTools(t, f, reconnectedSession, f.accounts[0].id)
	third := source.snapshot()
	mcpOAuthRotated(t, second, third)
	if reconnected.authorizations.Load() != 0 || sdk.trace.count("refresh_token") != 2 {
		t.Fatal("refresh after server reconstruction did not use the saved grant")
	}
	var after time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT g.expires_at FROM oauth_grants g JOIN oauth_tokens t ON t.grant_id=g.id WHERE t.signature=$1 AND t.kind='access'`, mcpOAuthSignature(third.AccessToken)).Scan(&after); err != nil || !after.Equal(familyExpiry) {
		t.Fatal("refresh extended the absolute family expiry")
	}
}

func TestMCPOAuthSDKRevocationAndRecovery(t *testing.T) {
	f := mcpOAuthOpen(t)
	first := f.sdk(t, 0, true, nil)
	firstSession := first.connect(t, "2025-11-25")
	other := f.sdk(t, 1, true, nil)
	otherSession := other.connect(t, "2025-11-25")
	firstToken := first.tokenSource(t).snapshot()
	otherToken := other.tokenSource(t).snapshot()

	grants := f.grants(t, 0)
	if len(grants) != 1 || grants[0].ClientID != first.tokenSource(t).clientID() {
		t.Fatal("connected apps do not belong to the signed-in account")
	}
	otherGrants := f.grants(t, 1)
	if len(otherGrants) != 1 || otherGrants[0].ID == grants[0].ID {
		t.Fatal("two accounts share a grant family")
	}
	mcpOAuthStatus(t, f.browser(t, 0, http.MethodDelete, "/v1/account/oauth/grants/"+otherGrants[0].ID, ""), http.StatusNotFound)
	mcpOAuthStatus(t, f.browser(t, 0, http.MethodDelete, "/v1/account/oauth/grants/"+grants[0].ID, ""), http.StatusNoContent)
	mcpOAuthStatus(t, f.raw(t, firstToken.AccessToken, "create_share", map[string]any{"content": "revoked must not write"}), http.StatusUnauthorized)
	f.requireRefreshDenied(t, first.tokenSource(t).clientID(), firstToken.RefreshToken)
	mcpOAuthTools(t, otherSession)
	if err := firstSession.Close(); err != nil {
		t.Fatal("close revoked session failed")
	}

	// A new SDK handler has no cached access/refresh tokens or registration.
	reauthorized := f.sdk(t, 0, true, nil)
	reauthorizedSession := reauthorized.connect(t, "2025-11-25")
	mcpOAuthExerciseTools(t, f, reauthorizedSession, f.accounts[0].id)
	reauthorized.requireDiscovery(t)
	recoveredToken := reauthorized.tokenSource(t).snapshot()
	if recoveredToken.AccessToken == firstToken.AccessToken || recoveredToken.RefreshToken == firstToken.RefreshToken {
		t.Fatal("reauthorization reused revoked credentials")
	}

	// This fixture applies recovery's generation boundary, not a second passkey
	// implementation. Auth/browser suites prove the real recovery ceremony.
	f.exec(t, `UPDATE accounts SET auth_generation=auth_generation+1 WHERE id=$1`, f.accounts[0].id)
	mcpOAuthStatus(t, f.raw(t, recoveredToken.AccessToken, "create_share", map[string]any{"content": "old generation must not write"}), http.StatusUnauthorized)
	f.requireRefreshDenied(t, reauthorized.tokenSource(t).clientID(), recoveredToken.RefreshToken)
	mcpOAuthStatus(t, f.raw(t, otherToken.AccessToken, "create_share", map[string]any{"content": "other account remains active"}), http.StatusOK)
	state, err := f.accountState(t.Context(), 0)
	if err != nil || state.Authenticated {
		t.Fatal("old browser session survived the generation change")
	}
	// Existing API keys deliberately survive account recovery on both routes.
	f.restCreate(t, 0, "legacy key after recovery")
	legacy := f.legacyConnect(t, "2025-03-26", 0)
	mcpOAuthExerciseTools(t, f, legacy, f.accounts[0].id)

	f.newSession(t, 0)
	fresh := f.sdk(t, 0, true, nil)
	freshSession := fresh.connect(t, "2025-11-25")
	mcpOAuthExerciseTools(t, f, freshSession, f.accounts[0].id)
	fresh.requireDiscovery(t)
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_grants g JOIN accounts a ON a.id=g.account_id WHERE g.account_id=$1 AND g.generation=a.auth_generation AND g.revoked_at IS NULL`, f.accounts[0].id) != 1 {
		t.Fatal("fresh consent did not bind the recovered generation")
	}
}

func TestMCPOAuthSDKReplayRevokesFamily(t *testing.T) {
	for _, replay := range []string{"refresh reuse", "code replay"} {
		t.Run(replay, func(t *testing.T) {
			f := mcpOAuthOpen(t)
			sdk := f.sdk(t, 0, true, nil)
			session := sdk.connect(t, "2025-11-25")
			source := sdk.tokenSource(t)
			original := source.snapshot()
			f.expireAccess(t, source)
			mcpOAuthTools(t, session)
			latest := source.snapshot()
			mcpOAuthRotated(t, original, latest)
			if err := session.Close(); err != nil {
				t.Fatal("close SDK session failed")
			}
			f.restart(t) // Replay tombstones must survive service reconstruction.
			form := sdk.trace.codeForm()
			if replay == "refresh reuse" {
				form = f.refreshForm(source.clientID(), original.RefreshToken)
			}
			mcpOAuthProtocolError(t, f.form(t, "/oauth/token", form), http.StatusBadRequest, "invalid_grant")
			mcpOAuthStatus(t, f.raw(t, latest.AccessToken, "create_share", map[string]any{"content": "replayed family must not write"}), http.StatusUnauthorized)
			f.requireRefreshDenied(t, source.clientID(), latest.RefreshToken)
			if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 1 ||
				testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE active`) != 0 ||
				testdb.Count(t, f.pool, `SELECT count(*) FROM shares`) != 0 {
				t.Fatal("replay did not revoke the latest family credentials")
			}
			fresh := f.sdk(t, 0, true, nil)
			mcpOAuthTools(t, fresh.connect(t, "2025-11-25"))
			fresh.requireDiscovery(t)
		})
	}
}

func TestMCPOAuthSDKDenialIssuesNoCredentials(t *testing.T) {
	f := mcpOAuthOpen(t)
	sdk := f.sdk(t, 0, false, nil)
	session, err := sdk.attempt(t.Context(), "2025-11-25")
	if session != nil {
		_ = session.Close()
	}
	if !errors.Is(err, errMCPOAuthDenied) || sdk.authorizations.Load() != 1 {
		sdk.mu.Lock()
		stage := sdk.consentError
		sdk.mu.Unlock()
		t.Fatalf("SDK did not report explicit consent denial: authorizations=%d, stage=%s", sdk.authorizations.Load(), stage)
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_grants`) != 0 ||
		testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens`) != 0 ||
		testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_requests`) != 0 ||
		sdk.trace.count("POST /oauth/token") != 0 {
		t.Fatal("denial retained a pending request or issued credentials")
	}
	if source, err := sdk.handler.TokenSource(t.Context()); err != nil || source != nil {
		t.Fatal("SDK cached credentials after denial")
	}
}

func TestMCPOAuthHTTPIdentityAndCredentialBoundaries(t *testing.T) {
	f := mcpOAuthOpen(t)
	var credentials [2]oauth2.Token
	for i := range f.accounts {
		sdk := f.sdk(t, i, true, nil)
		mcpOAuthExerciseTools(t, f, sdk.connect(t, "2025-11-25"), f.accounts[i].id)
		credentials[i] = sdk.tokenSource(t).snapshot()
	}
	// Reuse one forged MCP session ID and account marker across credentials.
	// Authentication must be evaluated again for each HTTP request.
	for _, i := range []int{0, 1, 0, 1} {
		var created CreateShareResponse
		mcpOAuthRawSuccess(t, f.raw(t, credentials[i].AccessToken, "create_share", map[string]any{"content": "per-request identity"}), &created)
		f.owner(t, created.Id, f.accounts[i].id)
	}
	sdk := f.sdk(t, 0, true, nil)
	_ = sdk.connect(t, "2025-11-25")
	tokens := sdk.tokenSource(t).snapshot()
	code := sdk.trace.codeForm().Get("code")
	before := testdb.Count(t, f.pool, `SELECT count(*) FROM shares`)
	for _, credential := range []struct{ name, value string }{
		{"missing", ""}, {"unknown", mcpOAuthRandom()}, {"refresh", tokens.RefreshToken},
		{"authorization code", code}, {"session as bearer", f.accounts[0].session},
		{"refresh with access prefix", "moa_" + strings.TrimPrefix(tokens.RefreshToken, "mor_")},
	} {
		t.Run(credential.name, func(t *testing.T) {
			r := f.raw(t, credential.value, "create_share", map[string]any{"content": "wrong credential must not write"})
			mcpOAuthStatus(t, r, http.StatusUnauthorized)
			mcpOAuthChallenge(t, r, f, false)
		})
	}
	headers := f.browserHeaders(0)
	mcpOAuthStatus(t, f.do(t, http.MethodPost, "/mcp", mcpDBPayload("create_share", map[string]any{"content": "cookie must not write"}), headers), http.StatusUnauthorized)
	if testdb.Count(t, f.pool, `SELECT count(*) FROM shares`) != before {
		t.Fatal("a non-access credential executed an MCP mutation")
	}

	created := f.restCreate(t, 0, "REST ownership boundary")
	for _, credential := range []string{tokens.AccessToken, tokens.RefreshToken, code, f.accounts[0].session} {
		headers := f.bearer(credential)
		mcpOAuthStatus(t, f.do(t, http.MethodPost, "/v1/shares", `{"content":"OAuth must not write REST"}`, headers), http.StatusUnauthorized)
		mcpOAuthStatus(t, f.do(t, http.MethodDelete, "/v1/shares/"+created.Id.String(), "", headers), http.StatusUnauthorized)
		for _, path := range []string{"/v1/account/oauth/grants", "/v1/passkeys", "/v1/api-keys", "/v1/account/shares"} {
			mcpOAuthStatus(t, f.do(t, http.MethodGet, path, "", headers), http.StatusUnauthorized)
		}
		stateResponse := f.do(t, http.MethodGet, "/v1/account", "", headers)
		mcpOAuthStatus(t, stateResponse, http.StatusOK)
		var state mcpOAuthAccountState
		mcpOAuthJSON(t, stateResponse.body, &state)
		if state.Authenticated || state.CSRF != "" || state.AccountID != "" {
			t.Fatal("Bearer credentials authenticated a browser account")
		}
		headers.Set("Origin", f.origin.String())
		headers.Set("X-CSRF-Token", mcpOAuthRandom())
		mcpOAuthStatus(t, f.do(t, http.MethodPost, "/v1/api-keys", `{"name":"must not exist"}`, headers), http.StatusUnauthorized)
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE id=$1 AND revoked_at IS NULL`, created.Id) != 1 ||
		testdb.Count(t, f.pool, `SELECT count(*) FROM shares`) != before+1 ||
		testdb.Count(t, f.pool, `SELECT count(*) FROM api_keys`) != 2 {
		t.Fatal("OAuth credentials changed REST or browser-managed state")
	}
	// A valid token does not relax the existing MCP Origin check.
	headers = f.bearer(tokens.AccessToken)
	headers.Set("Origin", "https://foreign.example")
	mcpOAuthStatus(t, f.do(t, http.MethodPost, "/mcp", mcpDBPayload("create_share", map[string]any{"content": "foreign Origin must not write"}), headers), http.StatusForbidden)
}

func TestMCPOAuthHTTPRejectsInvalidAccessState(t *testing.T) {
	for _, state := range []string{"resource", "issuer", "scope", "generation", "access expiry", "family expiry", "inactive", "revoked"} {
		t.Run(state, func(t *testing.T) {
			f := mcpOAuthOpen(t)
			sdk := f.sdk(t, 0, true, nil)
			_ = sdk.connect(t, "2025-11-25")
			tokens := sdk.tokenSource(t).snapshot()
			status := http.StatusUnauthorized
			switch state {
			case "resource":
				f.exec(t, `UPDATE oauth_grants SET resource=$1`, f.origin.String()+"/mcp/")
			case "issuer":
				f.exec(t, `UPDATE oauth_grants SET issuer='https://foreign.example'`)
			case "scope":
				// The normal schema cannot issue this scope. Remove its CHECK in
				// this isolated schema to test verifier defense against bad state.
				f.exec(t, `ALTER TABLE oauth_grants DROP CONSTRAINT oauth_grants_scope_check`)
				f.exec(t, `UPDATE oauth_grants SET scope='offline_access'`)
				status = http.StatusForbidden
			case "generation":
				f.exec(t, `UPDATE accounts SET auth_generation=auth_generation+1 WHERE id=$1`, f.accounts[0].id)
			case "access expiry":
				f.exec(t, `UPDATE oauth_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE kind='access'`)
			case "family expiry":
				f.exec(t, `UPDATE oauth_grants SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 second'`)
			case "inactive":
				f.exec(t, `UPDATE oauth_tokens SET active=false WHERE kind='access'`)
			case "revoked":
				mcpOAuthStatus(t, f.form(t, "/oauth/revoke", url.Values{"client_id": {sdk.tokenSource(t).clientID()}, "token": {tokens.RefreshToken}, "token_type_hint": {"refresh_token"}}), http.StatusOK)
			}
			r := f.raw(t, tokens.AccessToken, "create_share", map[string]any{"content": "invalid access state must not write"})
			mcpOAuthStatus(t, r, status)
			mcpOAuthChallenge(t, r, f, state == "scope")
			if testdb.Count(t, f.pool, `SELECT count(*) FROM shares`) != 0 {
				t.Fatal("invalid access state executed a tool")
			}
		})
	}
}

func TestMCPOAuthHTTPDatabaseFailureIsSafe(t *testing.T) {
	f := mcpOAuthOpen(t)
	sdk := f.sdk(t, 0, true, nil)
	session := sdk.connect(t, "2025-11-25")
	tokens := sdk.tokenSource(t).snapshot()
	mcpOAuthTools(t, session)
	f.pool.Close()
	for _, credential := range []string{tokens.AccessToken, f.accounts[0].key, "moa_" + mcpOAuthRandom()} {
		r := f.raw(t, credential, "create_share", map[string]any{"content": "outage must not write"})
		mcpOAuthStatus(t, r, http.StatusServiceUnavailable)
		var failure Error
		var fields map[string]json.RawMessage
		mcpOAuthJSON(t, r.body, &failure)
		mcpOAuthJSON(t, r.body, &fields)
		if len(fields) != 2 || failure.Code != ErrorCodeServiceUnavailable || failure.Message != "authentication is unavailable" || r.header.Get("WWW-Authenticate") != "" {
			t.Fatal("authentication outage did not return a safe service error")
		}
		if bytes.Contains(r.body, []byte(credential)) {
			t.Fatal("authentication outage reflected a credential")
		}
	}
}

type mcpOAuthAccount struct {
	id           uuid.UUID
	key, session string
}

type mcpOAuthRouter struct{ http.Handler }

type mcpOAuthFixture struct {
	pool     *pgxpool.Pool
	server   *httptest.Server
	origin   *url.URL
	http     *http.Client
	accounts [2]mcpOAuthAccount
	router   atomic.Pointer[mcpOAuthRouter]
	viewer   string
	session  string
	mu       sync.Mutex
	logs     bytes.Buffer
	secrets  []string
}

func mcpOAuthOpen(t *testing.T) *mcpOAuthFixture {
	t.Helper()
	f := &mcpOAuthFixture{pool: testdb.Open(t), viewer: t.TempDir(), session: uuid.NewString()}
	if err := os.WriteFile(filepath.Join(f.viewer, "index.html"), []byte(`<!doctype html><head></head><body><div id="root"></div></body>`), 0o600); err != nil {
		t.Fatal("write viewer fixture failed")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("listen on loopback failed")
	}
	t.Cleanup(func() { _ = listener.Close() })
	f.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.router.Load().ServeHTTP(w, r)
	}))
	_ = f.server.Listener.Close()
	f.server.Listener = listener
	f.origin = &url.URL{Scheme: "http", Host: net.JoinHostPort("localhost", strconv.Itoa(listener.Addr().(*net.TCPAddr).Port))}
	for i := range f.accounts {
		f.accounts[i].id = testdb.Account(t, f.pool)
		f.accounts[i].key = "msk_" + mcpOAuthRandom()
		digest := sha256.Sum256([]byte(f.accounts[i].key))
		f.exec(t, `INSERT INTO api_keys(id,account_id,name,prefix,token_hash) VALUES($1,$2,'SDK fixture','fixture',$3)`, uuid.New(), f.accounts[i].id, digest[:])
		f.remember(f.accounts[i].key)
		f.newSession(t, i)
	}
	f.restart(t)
	f.server.Start()
	// No proxy, Host rewrite, or application-operation shortcut is used. The
	// socket URL is the configured localhost issuer, including its real port.
	transport := &http.Transport{Proxy: nil}
	f.http = &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	t.Cleanup(func() {
		transport.CloseIdleConnections()
		f.server.Close()
		f.mu.Lock()
		defer f.mu.Unlock()
		logs := f.logs.String()
		for _, secret := range f.secrets {
			if secret != "" && strings.Contains(logs, secret) {
				t.Error("application logs contain a private fixture credential or continuation")
				break
			}
		}
	})
	return f
}

func (f *mcpOAuthFixture) restart(t *testing.T) {
	t.Helper()
	accounts, err := auth.NewService(f.pool, f.origin)
	if err != nil {
		t.Fatal("construct account service failed")
	}
	repo := share.NewPostgresRepository(f.pool)
	logger := slog.New(slog.NewJSONHandler(f, nil))
	service := NewService(repo, share.TokenGenerator{}, f.origin, 4096, logger)
	preview, err := viewer.New(f.viewer, repo, f.origin)
	if err != nil {
		t.Fatal("construct viewer failed")
	}
	const maxBody = 16384
	f.router.Store(&mcpOAuthRouter{NewRouter(service, RouterConfig{
		Authenticator: accounts, Account: accounts, OAuth: accounts.OAuthHandler(), Viewer: preview,
		MCP: NewMCPHandler(service, accounts, maxBody), Logger: logger,
		MaxRequestBody: maxBody, RequestTimeout: 10 * time.Second,
	})})
}

func (f *mcpOAuthFixture) Write(data []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.logs.Write(data)
}

func (f *mcpOAuthFixture) remember(values ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, value := range values {
		if value != "" {
			f.secrets = append(f.secrets, value)
		}
	}
}

func (f *mcpOAuthFixture) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), query, args...); err != nil {
		t.Fatalf("fixture SQL failed (%T)", err)
	}
}

func (f *mcpOAuthFixture) newSession(t *testing.T, index int) {
	t.Helper()
	// Only owned, hash-only browser fixtures are seeded. Consent is still
	// authorized through the real private HTTP endpoints and fresh session.
	p := &f.accounts[index]
	p.session = mcpOAuthRandom()
	csrf := mcpOAuthRandom()
	digest := sha256.Sum256([]byte(p.session))
	f.exec(t, `INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at) SELECT $1,id,auth_generation,$3,clock_timestamp()+interval '1 day' FROM accounts WHERE id=$2`, digest[:], p.id, csrf)
	f.remember(p.session, csrf)
}

func mcpOAuthRandom() string {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic("generate private fixture credential failed")
	}
	return base64.RawURLEncoding.EncodeToString(raw[:])
}

func mcpOAuthSignature(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}

func (f *mcpOAuthFixture) request(ctx context.Context, method, target, body string, headers http.Header) (mcpDBResponse, error) {
	if strings.HasPrefix(target, "/") {
		target = f.origin.String() + target
	}
	r, err := http.NewRequestWithContext(ctx, method, target, strings.NewReader(body))
	if err != nil {
		return mcpDBResponse{}, errors.New("construct HTTP request failed")
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("MCP-Protocol-Version", "2025-11-25")
	for name, values := range headers {
		r.Header[name] = append([]string(nil), values...)
	}
	response, err := f.http.Do(r)
	if err != nil {
		return mcpDBResponse{}, errors.New("HTTP request failed")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return mcpDBResponse{}, errors.New("read HTTP response failed")
	}
	return mcpDBResponse{status: response.StatusCode, header: response.Header, body: data}, nil
}

func (f *mcpOAuthFixture) do(t *testing.T, method, target, body string, headers http.Header) mcpDBResponse {
	t.Helper()
	r, err := f.request(t.Context(), method, target, body, headers)
	if err != nil {
		t.Fatal("application HTTP request failed")
	}
	return r
}

func (f *mcpOAuthFixture) bearer(token string) http.Header {
	h := http.Header{"Mcp-Session-Id": {f.session}, "X-Morsel-Account-Id": {f.accounts[1].id.String()}}
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
	return h
}

func (f *mcpOAuthFixture) raw(t *testing.T, token, tool string, arguments any) mcpDBResponse {
	t.Helper()
	r := f.do(t, http.MethodPost, "/mcp", mcpDBPayload(tool, arguments), f.bearer(token))
	if r.header.Get("Cache-Control") != "no-store" || r.header.Get("Mcp-Session-Id") != "" || r.header.Get("X-Morsel-Account-ID") != "" || r.header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("MCP response changed stateless security headers")
	}
	return r
}

func (f *mcpOAuthFixture) form(t *testing.T, path string, values url.Values) mcpDBResponse {
	t.Helper()
	return f.do(t, http.MethodPost, path, values.Encode(), http.Header{"Content-Type": {"application/x-www-form-urlencoded"}})
}

func (f *mcpOAuthFixture) refreshForm(client, refresh string) url.Values {
	return url.Values{"grant_type": {"refresh_token"}, "client_id": {client}, "resource": {f.origin.String() + "/mcp"}, "refresh_token": {refresh}}
}

func (f *mcpOAuthFixture) requireRefreshDenied(t *testing.T, client, refresh string) {
	t.Helper()
	mcpOAuthProtocolError(t, f.form(t, "/oauth/token", f.refreshForm(client, refresh)), http.StatusBadRequest, "invalid_grant")
}

func (f *mcpOAuthFixture) browserHeaders(index int) http.Header {
	return http.Header{"Cookie": {"morsel_session=" + f.accounts[index].session}, "Origin": {f.origin.String()}, "X-Morsel-Account-Id": {f.accounts[index].id.String()}}
}

type mcpOAuthAccountState struct {
	Authenticated        bool   `json:"authenticated"`
	AccountID            string `json:"account_id"`
	CSRF                 string `json:"csrf_token"`
	VerificationRequired bool   `json:"verification_required"`
}

func (f *mcpOAuthFixture) accountState(ctx context.Context, index int) (mcpOAuthAccountState, error) {
	r, err := f.request(ctx, http.MethodGet, "/v1/account", "", f.browserHeaders(index))
	var state mcpOAuthAccountState
	if err != nil || r.status != http.StatusOK || json.Unmarshal(r.body, &state) != nil {
		return state, errors.New("fetch browser account failed")
	}
	f.remember(state.CSRF)
	return state, nil
}

func (f *mcpOAuthFixture) browser(t *testing.T, index int, method, path, body string) mcpDBResponse {
	t.Helper()
	state, err := f.accountState(t.Context(), index)
	if err != nil || !state.Authenticated || state.VerificationRequired || state.AccountID != f.accounts[index].id.String() || state.CSRF == "" {
		t.Fatal("browser fixture has no fresh current-account session")
	}
	h := f.browserHeaders(index)
	h.Set("X-CSRF-Token", state.CSRF)
	return f.do(t, method, path, body, h)
}

type mcpOAuthGrant struct {
	ID       string `json:"id"`
	ClientID string `json:"client_id"`
}

func (f *mcpOAuthFixture) grants(t *testing.T, index int) []mcpOAuthGrant {
	t.Helper()
	r := f.browser(t, index, http.MethodGet, "/v1/account/oauth/grants", "")
	mcpOAuthStatus(t, r, http.StatusOK)
	if r.header.Get("X-Morsel-Account-ID") != f.accounts[index].id.String() {
		t.Fatal("connected apps lost the current-account response marker")
	}
	var grants []mcpOAuthGrant
	mcpOAuthJSON(t, r.body, &grants)
	return grants
}

func (f *mcpOAuthFixture) restCreate(t *testing.T, index int, content string) CreateShareResponse {
	t.Helper()
	r := f.do(t, http.MethodPost, "/v1/shares", mcpDBJSON(map[string]any{"content": content}), f.bearer(f.accounts[index].key))
	mcpOAuthStatus(t, r, http.StatusCreated)
	var created CreateShareResponse
	mcpOAuthJSON(t, r.body, &created)
	f.owner(t, created.Id, f.accounts[index].id)
	return created
}

func (f *mcpOAuthFixture) owner(t *testing.T, id, owner uuid.UUID) {
	t.Helper()
	if id == uuid.Nil || testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE id=$1 AND account_id=$2`, id, owner) != 1 {
		t.Fatal("share ownership did not come from this HTTP request's credential")
	}
}

// SDK v1.8.0 exposes AuthorizationCodeHandler and StreamableClientTransport's
// OAuthHandler, not NewOAuthHTTPClient. Its oauth2.Config.TokenSource also omits
// RFC 8707 resource during refresh. This configured HTTP client adds only that
// required form field; discovery, DCR, PKCE, exchange, and refresh still use the
// official SDK/oauth2 implementations and actual application endpoints.
func (f *mcpOAuthFixture) sdkHTTP(trace *mcpOAuthTrace, index int) *http.Client {
	return &http.Client{Timeout: 15 * time.Second, Transport: mcpRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme+"://"+r.URL.Host != f.origin.String() {
			return nil, errors.New("SDK request left the configured issuer")
		}
		request := r.Clone(r.Context())
		trace.add(r.Method + " " + r.URL.Path)
		if r.URL.Path == "/mcp" {
			request.Header.Set("Mcp-Session-Id", f.session)
			request.Header.Set("X-Morsel-Account-ID", f.accounts[1-index].id.String())
		}
		if r.Method == http.MethodPost && r.URL.Path == "/oauth/token" {
			data, err := io.ReadAll(io.LimitReader(r.Body, 16385))
			_ = r.Body.Close()
			if err != nil {
				return nil, errors.New("read SDK token request failed")
			}
			form, err := url.ParseQuery(string(data))
			if err != nil {
				return nil, errors.New("decode SDK token form failed")
			}
			if form.Get("grant_type") == "refresh_token" {
				form.Set("resource", f.origin.String()+"/mcp")
			}
			if form.Get("resource") != f.origin.String()+"/mcp" {
				return nil, errors.New("SDK token request has no bound resource")
			}
			f.remember(form.Get("code"), form.Get("code_verifier"), form.Get("refresh_token"))
			trace.tokenForm(form)
			body := form.Encode()
			request.Body = io.NopCloser(strings.NewReader(body))
			request.ContentLength = int64(len(body))
			request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(body)), nil }
		}
		return f.http.Transport.RoundTrip(request)
	})}
}

type mcpOAuthTrace struct {
	mu       sync.Mutex
	requests map[string]int
	code     url.Values
}

func (s *mcpOAuthTrace) add(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.requests == nil {
		s.requests = make(map[string]int)
	}
	s.requests[key]++
}

func (s *mcpOAuthTrace) tokenForm(form url.Values) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests[form.Get("grant_type")]++
	if form.Get("grant_type") == "authorization_code" {
		s.code = form
	}
}

func (s *mcpOAuthTrace) codeForm() url.Values {
	s.mu.Lock()
	defer s.mu.Unlock()
	clone := make(url.Values, len(s.code))
	for key, values := range s.code {
		clone[key] = append([]string(nil), values...)
	}
	return clone
}

func (s *mcpOAuthTrace) count(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests[key]
}

type mcpOAuthSDK struct {
	fixture        *mcpOAuthFixture
	handler        *mcpauth.AuthorizationCodeHandler
	http           *http.Client
	trace          *mcpOAuthTrace
	authorizations atomic.Int64
	mu             sync.Mutex
	source         *mcpOAuthTokenSource
	consentError   string
}

var errMCPOAuthDenied = errors.New("fixture consent denied")

func (f *mcpOAuthFixture) sdk(t *testing.T, index int, approve bool, initial *mcpOAuthTokenSource) *mcpOAuthSDK {
	t.Helper()
	s := &mcpOAuthSDK{fixture: f, trace: &mcpOAuthTrace{}, source: initial}
	s.http = f.sdkHTTP(s.trace, index)
	callbacks := make(chan url.Values, 1)
	callback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/callback" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		select {
		case callbacks <- r.URL.Query():
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusConflict)
		}
	}))
	t.Cleanup(callback.Close)
	redirect := callback.URL + "/callback"
	cfg := &mcpauth.AuthorizationCodeHandlerConfig{
		Client: s.http, RequestRefreshToken: true,
		DynamicClientRegistrationConfig: &mcpauth.DynamicClientRegistrationConfig{Metadata: &oauthex.ClientRegistrationMetadata{
			ClientName: "Official Go SDK fixture", RedirectURIs: []string{redirect}, ApplicationType: "native",
			TokenEndpointAuthMethod: "none", GrantTypes: []string{"authorization_code", "refresh_token"},
			ResponseTypes: []string{"code"}, Scope: mcpOAuthScope,
		}},
		AuthorizationCodeFetcher: func(ctx context.Context, args *mcpauth.AuthorizationArgs) (*mcpauth.AuthorizationResult, error) {
			s.authorizations.Add(1)
			result, err := f.consent(ctx, index, approve, args.URL, redirect, callbacks)
			if err != nil {
				s.mu.Lock()
				s.consentError = err.Error() // consent returns only fixed, secret-free errors.
				s.mu.Unlock()
			}
			return result, err
		},
		NewTokenSource: func(ctx context.Context, cfg *oauth2.Config, token *oauth2.Token) (oauth2.TokenSource, error) {
			if token.AccessToken == "" || token.RefreshToken == "" || token.Expiry.IsZero() || cfg.Endpoint.TokenURL != f.origin.String()+"/oauth/token" {
				return nil, errors.New("SDK did not obtain a finite offline grant")
			}
			source := &mcpOAuthTokenSource{ctx: ctx, cfg: *cfg, source: cfg.TokenSource(ctx, token), last: *token, fixture: f}
			f.remember(token.AccessToken, token.RefreshToken)
			s.mu.Lock()
			s.source = source
			s.mu.Unlock()
			return source, nil
		},
	}
	if initial != nil {
		cfg.InitialTokenSource = initial
	}
	var err error
	s.handler, err = mcpauth.NewAuthorizationCodeHandler(cfg)
	if err != nil {
		t.Fatalf("construct official SDK authorization handler failed (%T)", err)
	}
	return s
}

func (f *mcpOAuthFixture) consent(ctx context.Context, index int, approve bool, authorization, redirect string, callbacks <-chan url.Values) (*mcpauth.AuthorizationResult, error) {
	authorizeURL, err := url.Parse(authorization)
	if err != nil || authorizeURL.Scheme+"://"+authorizeURL.Host != f.origin.String() || authorizeURL.Path != "/oauth/authorize" ||
		authorizeURL.Query().Get("resource") != f.origin.String()+"/mcp" || (authorizeURL.Query().Get("scope") != mcpOAuthScope && authorizeURL.Query().Get("scope") != "offline_access mcp:shares") ||
		authorizeURL.Query().Get("code_challenge_method") != "S256" || authorizeURL.Query().Get("redirect_uri") != redirect {
		return nil, errors.New("SDK authorization parameters are not bound to the application")
	}
	f.remember(authorizeURL.Query().Get("state"))
	var tokensBefore, grantsBefore int64
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_tokens),(SELECT count(*) FROM oauth_grants)`).Scan(&tokensBefore, &grantsBefore); err != nil {
		return nil, errors.New("read pre-consent fixture state failed")
	}
	begin, err := f.request(ctx, http.MethodGet, authorization, "", nil)
	if err != nil || begin.status != http.StatusFound || begin.header.Get("Cache-Control") != "no-store" {
		return nil, errors.New("begin application authorization failed")
	}
	pending, err := url.Parse(begin.header.Get("Location"))
	if err != nil || pending.Scheme+"://"+pending.Host != f.origin.String() || pending.Path != "/oauth/consent" || len(pending.Query()) != 1 || len(pending.Query().Get("request")) != 43 {
		return nil, errors.New("application returned an invalid consent continuation")
	}
	handle := pending.Query().Get("request")
	f.remember(handle)
	page, err := f.request(ctx, http.MethodGet, pending.String(), "", f.browserHeaders(index))
	if err != nil || page.status != http.StatusOK || !strings.Contains(page.header.Get("Content-Type"), "text/html") || page.header.Get("Referrer-Policy") != "no-referrer" {
		return nil, errors.New("load consent viewer route failed")
	}
	state, err := f.accountState(ctx, index)
	if err != nil || !state.Authenticated || state.VerificationRequired || state.AccountID != f.accounts[index].id.String() || state.CSRF == "" {
		return nil, errors.New("consent has no fresh current-account browser session")
	}
	path := "/v1/account/oauth/requests/" + handle
	consent, err := f.request(ctx, http.MethodGet, path, "", f.browserHeaders(index))
	var view struct {
		AccountID    string `json:"account_id"`
		ClientID     string `json:"client_id"`
		ClientName   string `json:"client_name"`
		RedirectHost string `json:"redirect_host"`
		Resource     string `json:"resource"`
		Scope        string `json:"scope"`
	}
	callbackURL, _ := url.Parse(redirect)
	if err != nil || consent.status != http.StatusOK || json.Unmarshal(consent.body, &view) != nil ||
		view.AccountID != state.AccountID || consent.header.Get("X-Morsel-Account-ID") != state.AccountID ||
		view.ClientID != authorizeURL.Query().Get("client_id") || view.ClientName != "Official Go SDK fixture" ||
		view.Resource != f.origin.String()+"/mcp" || view.Scope != mcpOAuthScope || view.RedirectHost != callbackURL.Host {
		return nil, errors.New("consent view is not bound to the displayed account and client")
	}
	var tokensAfter, grantsAfter int64
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_tokens),(SELECT count(*) FROM oauth_grants)`).Scan(&tokensAfter, &grantsAfter); err != nil || tokensAfter != tokensBefore || grantsAfter != grantsBefore {
		return nil, errors.New("consent GET issued credentials")
	}
	headers := f.browserHeaders(index)
	headers.Set("X-CSRF-Token", state.CSRF)
	decision, err := f.request(ctx, http.MethodPost, path, mcpDBJSON(map[string]any{"approve": approve, "account_id": state.AccountID}), headers)
	var result struct {
		Redirect string `json:"redirect_url"`
	}
	if err != nil || decision.status != http.StatusOK || json.Unmarshal(decision.body, &result) != nil || decision.header.Get("X-Morsel-Account-ID") != state.AccountID {
		return nil, errors.New("submit application consent decision failed")
	}
	location, err := url.Parse(result.Redirect)
	if err != nil || location.Scheme != callbackURL.Scheme || location.Host != callbackURL.Host || location.Path != callbackURL.Path || location.Fragment != "" || location.User != nil ||
		len(location.Query()) != 3 || len(location.Query()["state"]) != 1 || len(location.Query()["iss"]) != 1 ||
		location.Query().Get("state") != authorizeURL.Query().Get("state") || location.Query().Get("iss") != f.origin.String() {
		return nil, errors.New("consent callback lost redirect, state, or issuer binding")
	}
	f.remember(location.Query().Get("code"))
	// This is only the native callback listener, never an authorization server.
	completion, err := f.request(ctx, http.MethodGet, result.Redirect, "", nil)
	if err != nil || completion.status != http.StatusNoContent {
		return nil, errors.New("deliver native callback failed")
	}
	select {
	case query := <-callbacks:
		if !approve {
			if query.Get("error") != "access_denied" || query.Get("code") != "" {
				return nil, errors.New("consent denial returned a code")
			}
			return nil, errMCPOAuthDenied
		}
		if query.Get("code") == "" || query.Get("error") != "" {
			return nil, errors.New("consent approval omitted its code")
		}
		return &mcpauth.AuthorizationResult{Code: query.Get("code"), State: query.Get("state"), Iss: query.Get("iss")}, nil
	case <-ctx.Done():
		return nil, errors.New("native callback canceled")
	}
}

func (s *mcpOAuthSDK) attempt(ctx context.Context, version string) (*mcp.ClientSession, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: "official-oauth-fixture", Version: "test"}, &mcp.ClientOptions{Capabilities: &mcp.ClientCapabilities{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	return client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: s.fixture.origin.String() + "/mcp", HTTPClient: s.http, OAuthHandler: s.handler, MaxRetries: -1}, &mcp.ClientSessionOptions{ProtocolVersion: version})
}

func (s *mcpOAuthSDK) connect(t *testing.T, version string) *mcp.ClientSession {
	t.Helper()
	session, err := s.attempt(t.Context(), version)
	if err != nil {
		s.mu.Lock()
		stage := s.consentError
		s.mu.Unlock()
		t.Fatalf("official SDK OAuth connect failed (%T): authorizations=%d, code exchanges=%d, stage=%s", err, s.authorizations.Load(), s.trace.count("authorization_code"), stage)
	}
	t.Cleanup(func() { _ = session.Close() })
	if session.InitializeResult().ProtocolVersion != version {
		t.Fatal("SDK negotiated a different advertised MCP version")
	}
	return session
}

func (s *mcpOAuthSDK) tokenSource(t *testing.T) *mcpOAuthTokenSource {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.source == nil {
		t.Fatal("SDK did not install its token source")
	}
	return s.source
}

func (s *mcpOAuthSDK) requireDiscovery(t *testing.T) {
	t.Helper()
	for _, key := range []string{"GET /.well-known/oauth-protected-resource/mcp", "GET /.well-known/oauth-authorization-server", "POST /oauth/register", "authorization_code"} {
		if s.trace.count(key) != 1 {
			t.Fatalf("SDK endpoint %s count=%d, want 1", key, s.trace.count(key))
		}
	}
	if s.authorizations.Load() != 1 {
		t.Fatal("SDK did not complete exactly one explicit consent")
	}
}

// This wrapper retains the real oauth2 token source. Expiration replaces only
// the cached access expiry; the refresh credential and SDK OAuth config remain.
// The mutex also covers the background requests made by the MCP transport.
type mcpOAuthTokenSource struct {
	mu      sync.Mutex
	ctx     context.Context
	cfg     oauth2.Config
	source  oauth2.TokenSource
	last    oauth2.Token
	fixture *mcpOAuthFixture
}

func (s *mcpOAuthTokenSource) Token() (*oauth2.Token, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	token, err := s.source.Token()
	if err != nil {
		return nil, err
	}
	s.last = *token
	s.fixture.remember(token.AccessToken, token.RefreshToken)
	copy := *token
	return &copy, nil
}

func (s *mcpOAuthTokenSource) snapshot() oauth2.Token {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last
}

func (s *mcpOAuthTokenSource) clientID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.ClientID
}

func (f *mcpOAuthFixture) expireAccess(t *testing.T, source *mcpOAuthTokenSource) {
	t.Helper()
	source.mu.Lock()
	defer source.mu.Unlock()
	f.exec(t, `UPDATE oauth_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE signature=$1 AND kind='access'`, mcpOAuthSignature(source.last.AccessToken))
	expired := source.last
	expired.Expiry = time.Now().Add(-time.Minute)
	source.source = source.cfg.TokenSource(source.ctx, &expired)
}

func (f *mcpOAuthFixture) keyClient(index int) *http.Client {
	return &http.Client{Timeout: 15 * time.Second, Transport: mcpRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		request := r.Clone(r.Context())
		request.Header.Set("Authorization", "Bearer "+f.accounts[index].key)
		request.Header.Set("Mcp-Session-Id", f.session)
		request.Header.Set("X-Morsel-Account-ID", f.accounts[1-index].id.String())
		return f.http.Transport.RoundTrip(request)
	})}
}

func (f *mcpOAuthFixture) legacyConnect(t *testing.T, version string, index int) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "legacy-key-fixture", Version: "test"}, &mcp.ClientOptions{Capabilities: &mcp.ClientCapabilities{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{Endpoint: f.origin.String() + "/mcp", HTTPClient: f.keyClient(index), MaxRetries: -1}, &mcp.ClientSessionOptions{ProtocolVersion: version})
	if err != nil {
		t.Fatalf("legacy SDK connect failed (%T)", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	if session.InitializeResult().ProtocolVersion != version {
		t.Fatal("legacy SDK negotiated a different version")
	}
	return session
}

func mcpOAuthTools(t *testing.T, session *mcp.ClientSession) {
	t.Helper()
	if err := session.Ping(t.Context(), nil); err != nil {
		t.Fatalf("SDK ping failed (%T)", err)
	}
	tools, err := session.ListTools(t.Context(), nil)
	if err != nil || tools == nil || len(tools.Tools) != 3 {
		t.Fatal("SDK did not list the three share tools")
	}
	names := map[string]bool{"create_share": true, "get_share": true, "revoke_share": true}
	for _, tool := range tools.Tools {
		if !names[tool.Name] || tool.InputSchema == nil || tool.OutputSchema == nil {
			t.Fatal("SDK received an unexpected tool contract")
		}
		delete(names, tool.Name)
	}
}

func mcpOAuthCall(t *testing.T, session *mcp.ClientSession, name string, arguments any) (json.RawMessage, bool) {
	t.Helper()
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil || result == nil || len(result.Content) != 1 || result.StructuredContent == nil {
		t.Fatalf("SDK %s failed or omitted tool content", name)
	}
	text, ok := result.Content[0].(*mcp.TextContent)
	if !ok || !json.Valid([]byte(text.Text)) {
		t.Fatal("SDK tool response has no JSON text content")
	}
	// SDK StructuredContent uses float64; text preserves the exact JSON integers.
	return json.RawMessage(text.Text), result.IsError
}

func mcpOAuthExerciseTools(t *testing.T, f *mcpOAuthFixture, session *mcp.ClientSession, owner uuid.UUID) {
	t.Helper()
	data, failed := mcpOAuthCall(t, session, "create_share", json.RawMessage(`{"content":"exact OAuth integer","max_views":9223372036854775807}`))
	var created CreateShareResponse
	mcpOAuthSuccess(t, data, failed, &created)
	mcpOAuthExactNumber(t, data, "max_views", math.MaxInt64)
	f.owner(t, created.Id, owner)
	if testdb.Count(t, f.pool, `SELECT max_views FROM shares WHERE id=$1`, created.Id) != math.MaxInt64 {
		t.Fatal("SDK share creation rounded max_views")
	}
	data, failed = mcpOAuthCall(t, session, "get_share", map[string]any{"token": mcpOAuthCapability(t, f, created)})
	var read Share
	mcpOAuthSuccess(t, data, failed, &read)
	mcpOAuthExactNumber(t, data, "max_views", math.MaxInt64)
	mcpOAuthExactNumber(t, data, "views_remaining", math.MaxInt64-1)
	if read.Content != "exact OAuth integer" || read.ViewCount != 1 || testdb.Count(t, f.pool, `SELECT view_count FROM shares WHERE id=$1`, created.Id) != 1 {
		t.Fatal("SDK capability read changed view consumption")
	}
	mcpOAuthNoIdentity(t, data, nil, f)
	data, failed = mcpOAuthCall(t, session, "revoke_share", map[string]any{"id": created.Id.String()})
	mcpOAuthSuccess(t, data, failed, nil)
	if testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE id=$1 AND account_id=$2 AND revoked_at IS NOT NULL`, created.Id, owner) != 1 {
		t.Fatal("SDK did not revoke its account-owned share")
	}
}

func mcpOAuthCapability(t *testing.T, f *mcpOAuthFixture, created CreateShareResponse) string {
	t.Helper()
	u, err := url.Parse(created.ShareUrl)
	if err != nil || u.Scheme+"://"+u.Host != f.origin.String() {
		t.Fatal("share capability did not use the configured origin")
	}
	path := u.Path
	if u.Fragment != "" {
		path = u.Fragment
	}
	token := strings.TrimPrefix(path, "/s/")
	if _, err := share.HashToken(token); err != nil {
		t.Fatal("SDK returned an invalid share capability")
	}
	f.remember(token)
	return token
}

func mcpOAuthRawSuccess(t *testing.T, r mcpDBResponse, target any) {
	t.Helper()
	mcpOAuthStatus(t, r, http.StatusOK)
	var envelope struct {
		Result mcpDBResult     `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	mcpOAuthJSON(t, r.body, &envelope)
	if len(envelope.Error) != 0 || len(envelope.Result.Structured) == 0 {
		t.Fatal("MCP request did not return a tool result")
	}
	mcpOAuthSuccess(t, envelope.Result.Structured, envelope.Result.IsError, target)
}

func mcpOAuthJSON(t *testing.T, data []byte, target any) {
	t.Helper()
	if json.Unmarshal(data, target) != nil {
		t.Fatal("decode application JSON failed")
	}
}

func mcpOAuthStatus(t *testing.T, r mcpDBResponse, status int) {
	t.Helper()
	if r.status != status {
		t.Fatalf("HTTP status=%d, want %d", r.status, status)
	}
}

func mcpOAuthSuccess(t *testing.T, data []byte, failed bool, target any) {
	t.Helper()
	if failed {
		t.Fatal("share tool returned an application error")
	}
	if target != nil {
		mcpOAuthJSON(t, data, target)
	}
}

func mcpOAuthToolError(t *testing.T, data []byte, failed bool, want ErrorCode) {
	t.Helper()
	var failure Error
	mcpOAuthJSON(t, data, &failure)
	if !failed || failure.Code != want || failure.Message == "" {
		t.Fatal("share tool returned an unexpected error")
	}
}

func mcpOAuthProtocolError(t *testing.T, r mcpDBResponse, status int, code string) {
	t.Helper()
	mcpOAuthStatus(t, r, status)
	var fields map[string]json.RawMessage
	mcpOAuthJSON(t, r.body, &fields)
	var actual string
	mcpOAuthJSON(t, fields["error"], &actual)
	if actual != code || len(fields) != 1 || r.header.Get("Cache-Control") != "no-store" || r.header.Get("Location") != "" {
		t.Fatal("OAuth endpoint did not return a safe protocol error")
	}
}

func mcpOAuthChallenge(t *testing.T, r mcpDBResponse, f *mcpOAuthFixture, insufficient bool) {
	t.Helper()
	challenges, err := oauthex.ParseWWWAuthenticate(r.header.Values("WWW-Authenticate"))
	if err != nil || len(challenges) != 1 || challenges[0].Scheme != "bearer" || challenges[0].Params["realm"] != "morsel" ||
		challenges[0].Params["resource_metadata"] != f.origin.String()+"/.well-known/oauth-protected-resource/mcp" || challenges[0].Params["scope"] != mcpOAuthScope {
		t.Fatal("MCP challenge omitted configured resource metadata or offline scope")
	}
	want := ""
	if insufficient {
		want = "insufficient_scope"
	}
	if challenges[0].Params["error"] != want {
		t.Fatal("MCP challenge has an incorrect scope error")
	}
}

func mcpOAuthExactNumber(t *testing.T, data []byte, field string, want int64) {
	t.Helper()
	var fields map[string]json.RawMessage
	mcpOAuthJSON(t, data, &fields)
	if string(fields[field]) != strconv.FormatInt(want, 10) {
		t.Fatalf("SDK response rounded %s", field)
	}
}

func mcpOAuthNoIdentity(t *testing.T, data []byte, headers http.Header, f *mcpOAuthFixture) {
	t.Helper()
	if headers.Get("X-Morsel-Account-ID") != "" {
		t.Fatal("capability read returned an account response marker")
	}
	for _, marker := range []string{"account_id", "owner", "display_name", f.accounts[0].id.String(), f.accounts[1].id.String()} {
		if bytes.Contains(data, []byte(marker)) {
			t.Fatal("capability read exposed an account identity")
		}
	}
}

func mcpOAuthRotated(t *testing.T, previous, next oauth2.Token) {
	t.Helper()
	if previous.AccessToken == next.AccessToken || previous.RefreshToken == next.RefreshToken || next.AccessToken == "" || next.RefreshToken == "" || !next.Valid() {
		t.Fatal("SDK refresh did not rotate finite access and refresh credentials")
	}
}
