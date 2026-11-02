package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
	"github.com/ory/fosite"
	"github.com/ory/fosite/storage"
)

type oauthComponentFixture struct {
	service       *Service
	pool          *pgxpool.Pool
	accountID     uuid.UUID
	clientID      uuid.UUID
	grantID       uuid.UUID
	familyExpires time.Time
	redirect      string
	verifier      string
	challenge     string
	state         string
}

func newOAuthComponentFixture(t *testing.T) *oauthComponentFixture {
	t.Helper()
	s, pool := testService(t)
	enroll(t, s, pool)
	f := &oauthComponentFixture{
		service: s, pool: pool, accountID: testdb.AccountID(t, pool), clientID: uuid.New(), grantID: uuid.New(),
		redirect: "http://127.0.0.1:43123/callback", verifier: randomToken(), state: randomToken(),
	}
	hash := sha256.Sum256([]byte(f.verifier))
	f.challenge = base64.RawURLEncoding.EncodeToString(hash[:])
	redirects, _ := json.Marshal([]string{f.redirect})
	if _, err := pool.Exec(t.Context(), `INSERT INTO oauth_clients(id,name,redirect_uris,expires_at) VALUES($1,'Native test client',$2,clock_timestamp()+interval '31 days')`, f.clientID, redirects); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `INSERT INTO oauth_grants(id,account_id,generation,client_id,issuer,resource,scope,expires_at)
		SELECT $1,id,auth_generation,$2,$3,$4,'mcp:shares offline_access',clock_timestamp()+interval '30 days' FROM accounts WHERE id=$5 RETURNING expires_at`,
		f.grantID, f.clientID, s.origin, s.origin+"/mcp", f.accountID).Scan(&f.familyExpires); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *oauthComponentFixture) operation(t *testing.T, now time.Time) (context.Context, *oauthOperation) {
	t.Helper()
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	var accountID uuid.UUID
	if err := tx.QueryRow(t.Context(), `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, f.accountID).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	var expires, databaseNow time.Time
	if err := tx.QueryRow(t.Context(), `SELECT expires_at,clock_timestamp() FROM oauth_grants WHERE id=$1 FOR UPDATE`, f.grantID).Scan(&expires, &databaseNow); err != nil {
		t.Fatal(err)
	}
	if now.IsZero() {
		now = databaseNow
	}
	return newOAuthContext(t.Context(), tx, f.grantID.String(), f.accountID, expires, now)
}

func (f *oauthComponentFixture) request(t *testing.T, op *oauthOperation) *fosite.Request {
	t.Helper()
	request := fosite.NewRequest()
	request.SetID(op.grantID)
	request.Client = oauthPublicClient(f.service.origin, f.clientID.String(), []string{f.redirect})
	request.SetRequestedScopes(fosite.Arguments{"mcp:shares", "offline_access"})
	request.GrantScope("mcp:shares")
	request.GrantScope("offline_access")
	request.SetRequestedAudience(fosite.Arguments{f.service.origin + "/mcp"})
	request.GrantAudience(f.service.origin + "/mcp")
	request.SetSession(&fosite.DefaultSession{Subject: f.accountID.String()})
	return request
}

func (f *oauthComponentFixture) authorize(t *testing.T, scope, challenge, method string) (string, error) {
	t.Helper()
	ctx, op := f.operation(t, time.Time{})
	form := url.Values{
		"client_id": {f.clientID.String()}, "redirect_uri": {f.redirect}, "response_type": {"code"},
		"scope": {scope}, "state": {f.state}, "resource": {f.service.origin + "/mcp"},
		"code_challenge": {challenge}, "code_challenge_method": {method},
	}
	provider := f.service.oauthProvider()
	r := httptest.NewRequest("GET", "/oauth/authorize?"+form.Encode(), nil)
	request, err := provider.NewAuthorizeRequest(ctx, r)
	if err == nil {
		request.SetID(f.grantID.String())
		request.SetRequestedAudience(fosite.Arguments{f.service.origin + "/mcp"})
		request.GrantAudience(f.service.origin + "/mcp")
		for _, requested := range request.GetRequestedScopes() {
			request.GrantScope(requested)
		}
		var response fosite.AuthorizeResponder
		response, err = provider.NewAuthorizeResponse(ctx, request, &fosite.DefaultSession{Subject: f.accountID.String(), Extra: map[string]interface{}{"must_not_persist": f.verifier}})
		if err == nil {
			if err := op.tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			return response.GetCode(), nil
		}
	}
	if err := op.tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	return "", err
}

func (f *oauthComponentFixture) code(t *testing.T) string {
	t.Helper()
	code, err := f.authorize(t, "mcp:shares offline_access", f.challenge, "S256")
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func (f *oauthComponentFixture) codeForm(code, verifier string) url.Values {
	return url.Values{"grant_type": {"authorization_code"}, "client_id": {f.clientID.String()}, "redirect_uri": {f.redirect}, "code": {code}, "code_verifier": {verifier}, "resource": {f.service.origin + "/mcp"}}
}
func (f *oauthComponentFixture) refreshForm(refresh string) url.Values {
	return url.Values{"grant_type": {"refresh_token"}, "client_id": {f.clientID.String()}, "refresh_token": {refresh}, "resource": {f.service.origin + "/mcp"}}
}
func oauthComponentHTTPForm(form url.Values) *http.Request {
	r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return r
}

func (f *oauthComponentFixture) exchange(t *testing.T, now time.Time, form url.Values) (fosite.AccessResponder, *oauthOperation, error) {
	t.Helper()
	ctx, op := f.operation(t, now)
	provider := f.service.oauthProvider()
	request, err := provider.NewAccessRequest(ctx, oauthComponentHTTPForm(form), new(fosite.DefaultSession))
	var response fosite.AccessResponder
	if err == nil {
		response, err = provider.NewAccessResponse(ctx, request)
	}
	if err == nil || op.replayed {
		if err := op.tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	} else if err := op.tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	return response, op, err
}

func oauthComponentRefresh(t *testing.T, response fosite.AccessResponder) string {
	t.Helper()
	refresh, ok := response.GetExtra("refresh_token").(string)
	if !ok || refresh == "" {
		t.Fatal("missing refresh token")
	}
	return refresh
}

func TestOAuthComponentProviderProfile(t *testing.T) {
	s := &Service{origin: "https://morsel.example"}
	var workers sync.WaitGroup
	for range 32 {
		workers.Go(func() {
			provider := s.oauthProvider().(oauthClockProvider).OAuth2Provider.(*fosite.Fosite)
			config := provider.Config.(*fosite.Config)
			if len(config.AuthorizeEndpointHandlers) != 2 || len(config.TokenEndpointHandlers) != 3 || len(config.TokenIntrospectionHandlers) != 0 || len(config.RevocationHandlers) != 0 || len(config.PushedAuthorizeEndpointHandlers) != 0 {
				t.Error("unexpected provider handlers")
			}
			if len(config.GlobalSecret) != 0 || len(config.RotatedGlobalSecrets) != 0 || !config.EnforcePKCE || !config.EnforcePKCEForPublicClients || config.EnablePKCEPlainChallengeMethod {
				t.Error("unsafe provider profile")
			}
			if config.GetScopeStrategy(t.Context())([]string{"mcp:shares"}, "mcp:*") || config.GetAudienceStrategy(t.Context())([]string{s.origin + "/mcp"}, []string{s.origin + "/other"}) == nil {
				t.Error("scope or audience matching broadened")
			}
			_ = config.GetSecretsHasher(t.Context())
		})
	}
	workers.Wait()
	if _, ok := any(&oauthStore{service: s}).(storage.Transactional); ok {
		t.Fatal("component can commit application transaction")
	}
}

func TestOAuthComponentCodeHydrationAndHashOnly(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code := f.code(t)
	ctx, op := f.operation(t, time.Time{})
	prototype := new(fosite.DefaultSession)
	request, err := (&oauthStore{service: f.service}).GetAuthorizeCodeSession(ctx, oauthTokenSignature(oauthCodePrefix, code), prototype)
	if err != nil || request.GetSession() != prototype || prototype.Subject != f.accountID.String() || !prototype.GetExpiresAt(fosite.AuthorizeCode).After(op.now) {
		t.Fatalf("code session was not hydrated: %v", err)
	}
	if err := (oauthStrategy{}).ValidateAuthorizeCode(ctx, fosite.NewAccessRequest(prototype), code); err != nil {
		t.Fatal("hydrated access-request prototype rejected", err)
	}
	if err := op.tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	response, op, err := f.exchange(t, time.Time{}, f.codeForm(code, f.verifier))
	if err != nil || op.replayed {
		t.Fatalf("code exchange failed: %v", err)
	}
	access, refresh := response.GetAccessToken(), oauthComponentRefresh(t, response)
	if oauthTokenSignature(oauthAccessPrefix, access) == "" || oauthTokenSignature(oauthRefreshPrefix, refresh) == "" {
		t.Fatal("invalid issued credential shape")
	}
	rows, err := f.pool.Query(t.Context(), `SELECT signature,kind,active,request_data::text,expires_at FROM oauth_tokens WHERE grant_id=$1`, f.grantID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	kinds := make(map[string]bool)
	for rows.Next() {
		var signature, kind, data string
		var active bool
		var expires time.Time
		if err := rows.Scan(&signature, &kind, &active, &data, &expires); err != nil {
			t.Fatal(err)
		}
		kinds[kind] = true
		if !oauthValidSignature(signature) || (kind == "code") == active || expires.After(f.familyExpires) {
			t.Fatal("unsafe persisted token state")
		}
		for _, secret := range []string{code, access, refresh, f.verifier, f.state, "code_verifier", "must_not_persist"} {
			if strings.Contains(data, secret) || strings.Contains(signature, secret) {
				t.Fatal("secret persisted in OAuth state")
			}
		}
		if kind == "access" && !expires.Equal(op.now.Add(oauthAccessLifetime)) {
			t.Fatal("access expiration is not based on operation clock")
		}
		if kind == "refresh" && !expires.Equal(f.familyExpires) {
			t.Fatal("refresh expiration moved beyond family deadline")
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(kinds) != 3 || kinds["pkce"] {
		t.Fatal("exchange did not consume code/PKCE atomically")
	}
}

func TestOAuthComponentPKCEFailureRollsBack(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code := f.code(t)
	for _, verifier := range []string{"", "short", strings.Repeat("a", 43), strings.Repeat("!", 43)} {
		_, op, err := f.exchange(t, time.Time{}, f.codeForm(code, verifier))
		if err == nil || op.replayed {
			t.Fatal("bad verifier accepted or treated as replay")
		}
		if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND active AND kind IN ('code','pkce')`, f.grantID) != 2 {
			t.Fatal("failed verifier consumed code or PKCE")
		}
	}
	// A successful NewAccessRequest deletes PKCE, but still must not commit it.
	ctx, op := f.operation(t, time.Time{})
	if _, err := f.service.oauthProvider().NewAccessRequest(ctx, oauthComponentHTTPForm(f.codeForm(code, f.verifier)), new(fosite.DefaultSession)); err != nil {
		t.Fatal(err)
	}
	if err := op.tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND kind='pkce'`, f.grantID) != 1 {
		t.Fatal("NewAccessRequest committed PKCE early")
	}
	if _, _, err := f.exchange(t, time.Time{}, f.codeForm(code, f.verifier)); err != nil {
		t.Fatal(err)
	}
}

func TestOAuthComponentPKCERequiredS256Only(t *testing.T) {
	f := newOAuthComponentFixture(t)
	for _, test := range []struct{ challenge, method string }{{"", ""}, {f.challenge, "plain"}, {f.challenge, ""}, {f.challenge, "S512"}} {
		if _, err := f.authorize(t, "mcp:shares offline_access", test.challenge, test.method); err == nil {
			t.Fatal("unsafe PKCE profile accepted")
		}
		if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1`, f.grantID) != 0 {
			t.Fatal("failed authorization committed a code")
		}
	}
	if _, err := f.authorize(t, "mcp:*", f.challenge, "S256"); err == nil {
		t.Fatal("wildcard scope accepted")
	}
}

func TestOAuthComponentRefreshRotationAndReuse(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code := f.code(t)
	first, firstOp, err := f.exchange(t, time.Time{}, f.codeForm(code, f.verifier))
	if err != nil {
		t.Fatal(err)
	}
	oldRefresh := oauthComponentRefresh(t, first)
	second, op, err := f.exchange(t, firstOp.now.Add(5*time.Minute), f.refreshForm(oldRefresh))
	if err != nil || op.replayed {
		t.Fatalf("refresh rotation failed: %v", err)
	}
	if second.GetAccessToken() == first.GetAccessToken() || oauthComponentRefresh(t, second) == oldRefresh {
		t.Fatal("refresh reused a credential")
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND active AND kind IN ('access','refresh')`, f.grantID) != 2 || testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND NOT active AND kind IN ('access','refresh')`, f.grantID) != 2 {
		t.Fatal("rotation did not preserve only the new active pair")
	}
	var expires time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT expires_at FROM oauth_tokens WHERE signature=$1 AND kind='refresh'`, oauthTokenSignature(oauthRefreshPrefix, oauthComponentRefresh(t, second))).Scan(&expires); err != nil || !expires.Equal(f.familyExpires) {
		t.Fatal("rotation extended absolute family expiration", err)
	}
	_, op, err = f.exchange(t, op.now.Add(time.Minute), f.refreshForm(oldRefresh))
	if !errors.Is(err, fosite.ErrInvalidGrant) || !op.replayed {
		t.Fatalf("refresh reuse did not revoke family: %v", err)
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_grants WHERE id=$1 AND revoked_at IS NOT NULL`, f.grantID) != 1 || testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND active`, f.grantID) != 0 || testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND kind='refresh'`, f.grantID) != 2 {
		t.Fatal("reuse did not retain tombstones and revoke all credentials")
	}
}

func TestOAuthComponentCodeReuseAfterCodeExpiryRevokesFamily(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code := f.code(t)
	_, firstOp, err := f.exchange(t, time.Time{}, f.codeForm(code, f.verifier))
	if err != nil {
		t.Fatal(err)
	}
	_, op, err := f.exchange(t, firstOp.now.Add(2*time.Minute), f.codeForm(code, f.verifier))
	if !errors.Is(err, fosite.ErrInvalidGrant) || !op.replayed || testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND active`, f.grantID) != 0 {
		t.Fatal("expired consumed-code tombstone did not revoke family", err)
	}
}

func TestOAuthComponentConcurrentRedemptionRevokesWinningPair(t *testing.T) {
	for _, grantType := range []string{"code", "refresh"} {
		t.Run(grantType, func(t *testing.T) {
			f := newOAuthComponentFixture(t)
			form := f.codeForm(f.code(t), f.verifier)
			if grantType == "refresh" {
				response, _, err := f.exchange(t, time.Time{}, form)
				if err != nil {
					t.Fatal(err)
				}
				form = f.refreshForm(oauthComponentRefresh(t, response))
			}
			type result struct {
				err      error
				replayed bool
			}
			results := make(chan result, 2)
			start := make(chan struct{})
			var workers sync.WaitGroup
			for range 2 {
				workers.Go(func() {
					<-start
					_, op, err := f.exchange(t, time.Time{}, form)
					results <- result{err, op.replayed}
				})
			}
			close(start)
			workers.Wait()
			close(results)
			var successes, replays int
			for result := range results {
				if result.err == nil && !result.replayed {
					successes++
				} else if errors.Is(result.err, fosite.ErrInvalidGrant) && result.replayed {
					replays++
				} else {
					t.Fatal("unexpected concurrent exchange result", result.err)
				}
			}
			// There is no retry/idempotence window: a second redemption, including
			// one caused by a lost response, revokes the winning token pair.
			if successes != 1 || replays != 1 || testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND active`, f.grantID) != 0 {
				t.Fatal("concurrent redemption did not revoke the family")
			}
		})
	}
}

func TestOAuthComponentNearFamilyDeadlineDoesNotSlide(t *testing.T) {
	f := newOAuthComponentFixture(t)
	first, _, err := f.exchange(t, time.Time{}, f.codeForm(f.code(t), f.verifier))
	if err != nil {
		t.Fatal(err)
	}
	response, op, err := f.exchange(t, f.familyExpires.Add(-30*time.Second), f.refreshForm(oauthComponentRefresh(t, first)))
	if err != nil {
		t.Fatal(err)
	}
	if response.GetExtra("expires_in") != int64(30) || testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND active AND expires_at=$2`, f.grantID, f.familyExpires) != 2 {
		t.Fatal("near-deadline response or persistence extended family expiration")
	}
	_, op, err = f.exchange(t, f.familyExpires, f.refreshForm(oauthComponentRefresh(t, response)))
	if !errors.Is(err, fosite.ErrInvalidGrant) || op.replayed {
		t.Fatal("refresh at absolute family expiry was accepted", err)
	}
}

func TestOAuthComponentOfflineScopeControlsRefresh(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code, err := f.authorize(t, "mcp:shares", f.challenge, "S256")
	if err != nil {
		t.Fatal(err)
	}
	response, _, err := f.exchange(t, time.Time{}, f.codeForm(code, f.verifier))
	if err != nil || response.GetExtra("refresh_token") != nil || testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND kind='refresh'`, f.grantID) != 0 {
		t.Fatal("refresh issued without offline_access", err)
	}
}

func TestOAuthComponentInactiveSessionsReturnRequester(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code := f.code(t)
	response, _, err := f.exchange(t, time.Time{}, f.codeForm(code, f.verifier))
	if err != nil {
		t.Fatal(err)
	}
	ctx, op := f.operation(t, time.Time{})
	store := &oauthStore{service: f.service}
	prototype := new(fosite.DefaultSession)
	request, err := store.GetAuthorizeCodeSession(ctx, oauthTokenSignature(oauthCodePrefix, code), prototype)
	if !errors.Is(err, fosite.ErrInvalidatedAuthorizeCode) || request == nil || request.GetID() != op.grantID || prototype.Subject != f.accountID.String() || op.replayed {
		t.Fatal("inactive code lost requester or prematurely marked replay", err)
	}
	signature := oauthTokenSignature(oauthRefreshPrefix, oauthComponentRefresh(t, response))
	if err := store.RotateRefreshToken(ctx, op.grantID, signature); err != nil {
		t.Fatal(err)
	}
	request, err = store.GetRefreshTokenSession(ctx, signature, prototype)
	if !errors.Is(err, fosite.ErrInactiveToken) || request == nil || request.GetID() != op.grantID || op.replayed {
		t.Fatal("inactive refresh lost requester or prematurely marked replay", err)
	}
	if err := store.RevokeRefreshToken(ctx, op.grantID); err != nil || !op.replayed {
		t.Fatal("successful replay revocation did not mark operation", err)
	}
}

func TestOAuthComponentBindingAndUnsupportedGrants(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code := f.code(t)
	otherClient := uuid.New()
	redirects, _ := json.Marshal([]string{f.redirect})
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO oauth_clients(id,name,redirect_uris,expires_at) VALUES($1,'Other client',$2,clock_timestamp()+interval '31 days')`, otherClient, redirects); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(url.Values){
		func(form url.Values) { form.Set("client_id", otherClient.String()) },
		func(form url.Values) { form.Set("redirect_uri", "http://127.0.0.1:43124/callback") },
		func(form url.Values) { form.Set("grant_type", "password") },
		func(form url.Values) { form.Set("grant_type", "client_credentials") },
		func(form url.Values) { form.Set("code", strings.Replace(code, oauthCodePrefix, oauthAccessPrefix, 1)) },
	} {
		form := f.codeForm(code, f.verifier)
		mutate(form)
		if _, op, err := f.exchange(t, time.Time{}, form); err == nil || op.replayed {
			t.Fatal("invalid token request accepted or revoked the family")
		}
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND active`, f.grantID) != 2 {
		t.Fatal("invalid request consumed code")
	}
}

func TestOAuthComponentOpaqueStrategyClockAndShape(t *testing.T) {
	f := newOAuthComponentFixture(t)
	ctx, op := f.operation(t, time.Time{})
	request := f.request(t, op)
	strategy := oauthStrategy{}
	for _, test := range []struct {
		prefix   string
		kind     fosite.TokenType
		generate func(context.Context, fosite.Requester) (string, string, error)
		validate func(context.Context, fosite.Requester, string) error
	}{{oauthCodePrefix, fosite.AuthorizeCode, strategy.GenerateAuthorizeCode, strategy.ValidateAuthorizeCode}, {oauthAccessPrefix, fosite.AccessToken, strategy.GenerateAccessToken, strategy.ValidateAccessToken}, {oauthRefreshPrefix, fosite.RefreshToken, strategy.GenerateRefreshToken, strategy.ValidateRefreshToken}} {
		token, signature, err := test.generate(ctx, request)
		hash := sha256.Sum256([]byte(token))
		if err != nil || signature != hex.EncodeToString(hash[:]) || len(token) != 47 || oauthTokenSignature(test.prefix, token) != signature {
			t.Fatal("opaque token generation failed", err)
		}
		if err := test.validate(ctx, request, token); err != nil {
			t.Fatal(err)
		}
		for _, invalid := range []string{token + "=", token[:46], token[:46] + "B", strings.ToUpper(test.prefix) + token[4:], "other_" + token[4:]} {
			if oauthTokenSignature(test.prefix, invalid) != "" || !errors.Is(test.validate(ctx, request, invalid), fosite.ErrInvalidTokenFormat) {
				t.Fatal("noncanonical opaque credential accepted")
			}
		}
		expires := request.GetSession().GetExpiresAt(test.kind)
		originalNow := op.now
		op.now = expires
		if !errors.Is(test.validate(ctx, request, token), fosite.ErrTokenExpired) {
			t.Fatal("expiration boundary accepted")
		}
		op.now = originalNow
	}
	// Database time, not the host wall clock, controls both generation and use.
	op.now = f.familyExpires.Add(-30 * time.Second)
	for _, generate := range []func(context.Context, fosite.Requester) (string, string, error){strategy.GenerateAuthorizeCode, strategy.GenerateAccessToken, strategy.GenerateRefreshToken} {
		if _, _, err := generate(ctx, request); err != nil {
			t.Fatal(err)
		}
	}
	for _, kind := range []fosite.TokenType{fosite.AuthorizeCode, fosite.AccessToken, fosite.RefreshToken} {
		if !request.GetSession().GetExpiresAt(kind).Equal(f.familyExpires) {
			t.Fatal("generation exceeded family deadline")
		}
	}
	op.now = f.familyExpires
	if _, _, err := strategy.GenerateRefreshToken(ctx, request); !errors.Is(err, fosite.ErrTokenExpired) {
		t.Fatal("expired family generated a token")
	}
}

func TestOAuthComponentStoreBindingExpiryAndErrors(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code := f.code(t)
	store := &oauthStore{service: f.service}
	ctx, op := f.operation(t, time.Time{})
	signature := oauthTokenSignature(oauthCodePrefix, code)
	for _, id := range []string{"", "not-a-uuid", uuid.Nil.String()} {
		if _, err := store.GetClient(ctx, id); !errors.Is(err, fosite.ErrNotFound) {
			t.Fatal("invalid client ID accepted")
		}
	}
	client, err := store.GetClient(ctx, f.clientID.String())
	if err != nil || !client.IsPublic() || !client.GetGrantTypes().Matches("authorization_code", "refresh_token") || !client.GetResponseTypes().ExactOne("code") || !client.GetScopes().Matches("mcp:shares", "offline_access") || !client.GetAudience().ExactOne(f.service.origin+"/mcp") {
		t.Fatal("stored client has an unsafe component profile", err)
	}
	var clientExpires time.Time
	if err := op.tx.QueryRow(ctx, `SELECT expires_at FROM oauth_clients WHERE id=$1`, f.clientID).Scan(&clientExpires); err != nil {
		t.Fatal(err)
	}
	originalNow := op.now
	op.now = clientExpires
	if _, err := store.GetClient(ctx, f.clientID.String()); !errors.Is(err, fosite.ErrNotFound) {
		t.Fatal("client expiration ignored operation clock")
	}
	op.now = originalNow
	request := f.request(t, op)
	request.SetID(uuid.NewString())
	if err := store.CreateAccessTokenSession(ctx, signature, request); err == nil {
		t.Fatal("foreign request ID accepted")
	}
	request.SetID(op.grantID)
	request.SetSession(&fosite.DefaultSession{Subject: uuid.NewString()})
	if err := store.CreateAccessTokenSession(ctx, signature, request); err == nil {
		t.Fatal("foreign account subject accepted")
	}
	request = f.request(t, op)
	request.GrantAudience(f.service.origin + "/other")
	if err := store.CreateAccessTokenSession(ctx, signature, request); err == nil {
		t.Fatal("foreign audience accepted")
	}
	var expires time.Time
	if err := op.tx.QueryRow(ctx, `SELECT expires_at FROM oauth_tokens WHERE signature=$1 AND kind='code'`, signature).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	op.now = expires
	if _, err := store.GetAuthorizeCodeSession(ctx, signature, new(fosite.DefaultSession)); !errors.Is(err, fosite.ErrNotFound) {
		t.Fatal("active expired code accepted")
	}
	op.now = f.familyExpires
	if _, err := store.GetAuthorizeCodeSession(ctx, signature, new(fosite.DefaultSession)); !errors.Is(err, fosite.ErrNotFound) {
		t.Fatal("expired grant accepted")
	}
	if _, err := store.GetAccessTokenSession(t.Context(), signature, new(fosite.DefaultSession)); !errors.Is(err, fosite.ErrServerError) {
		t.Fatal("storage accepted missing outer operation")
	}
	if err := op.tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	ctx, op = f.operation(t, time.Time{})
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = store.GetAuthorizeCodeSession(cancelled, signature, new(fosite.DefaultSession))
	if err != fosite.ErrServerError {
		t.Fatal("database failure leaked its error", err)
	}
	_ = op.tx.Rollback(context.Background())
	if _, err := f.pool.Exec(t.Context(), `UPDATE oauth_clients SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, f.clientID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetClient(t.Context(), f.clientID.String()); !errors.Is(err, fosite.ErrNotFound) {
		t.Fatal("client expiration did not use database clock")
	}
}

func TestOAuthComponentReplayMarkerRequiresSuccessfulRevocation(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code := f.code(t)
	if _, _, err := f.exchange(t, time.Time{}, f.codeForm(code, f.verifier)); err != nil {
		t.Fatal(err)
	}
	ctx, op := f.operation(t, time.Time{})
	store := &oauthStore{service: f.service}
	if _, err := store.GetAuthorizeCodeSession(ctx, oauthTokenSignature(oauthCodePrefix, code), new(fosite.DefaultSession)); !errors.Is(err, fosite.ErrInvalidatedAuthorizeCode) {
		t.Fatal(err)
	}
	if err := op.tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeAccessToken(ctx, op.grantID); err != fosite.ErrServerError || op.replayed {
		t.Fatal("failed replay revocation marked the transaction committable", err)
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_grants WHERE id=$1 AND revoked_at IS NULL`, f.grantID) != 1 {
		t.Fatal("failed replay revocation changed family")
	}
}

func TestOAuthComponentTokenLimitRollback(t *testing.T) {
	f := newOAuthComponentFixture(t)
	code := f.code(t)
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO oauth_tokens(signature,kind,grant_id,active,request_data,expires_at)
		SELECT lpad(to_hex(n),64,'0'),'access',$1,false,'{}'::jsonb,$2 FROM generate_series(1,$3) n`, f.grantID, f.familyExpires, oauthTokenLimit-2); err != nil {
		t.Fatal(err)
	}
	// PKCE deletion frees one row, then access insertion fills the family. The
	// refresh insertion fails, so all earlier changes must roll back together.
	_, op, err := f.exchange(t, time.Time{}, f.codeForm(code, f.verifier))
	if err == nil || op.replayed {
		t.Fatal("family token limit did not fail closed")
	}
	if testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1`, f.grantID) != oauthTokenLimit || testdb.Count(t, f.pool, `SELECT count(*) FROM oauth_tokens WHERE grant_id=$1 AND active AND kind IN ('code','pkce')`, f.grantID) != 2 {
		t.Fatal("failed token issuance partially committed")
	}
}

func TestOAuthComponentRotationRequiresOneActiveRow(t *testing.T) {
	f := newOAuthComponentFixture(t)
	response, _, err := f.exchange(t, time.Time{}, f.codeForm(f.code(t), f.verifier))
	if err != nil {
		t.Fatal(err)
	}
	ctx, op := f.operation(t, time.Time{})
	store := &oauthStore{service: f.service}
	signature := oauthTokenSignature(oauthRefreshPrefix, oauthComponentRefresh(t, response))
	if err := store.RotateRefreshToken(ctx, op.grantID, signature); err != nil {
		t.Fatal(err)
	}
	if err := store.RotateRefreshToken(ctx, op.grantID, signature); !errors.Is(err, fosite.ErrNotFound) || op.replayed {
		t.Fatal("rotation did not require exactly one active credential")
	}
	if err := store.RevokeAccessToken(ctx, op.grantID); err != nil || op.replayed {
		t.Fatal("ordinary revocation incorrectly marked replay", err)
	}
}
