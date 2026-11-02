package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/ory/fosite"
)

// OAuthHandler is separate from browser JSON endpoints. Protocol requests do
// not gain authority from browser cookies, and cannot relax browser CSRF rules.
func (s *Service) OAuthHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		metadata := r.URL.Path == "/.well-known/oauth-protected-resource/mcp" || r.URL.Path == "/.well-known/oauth-authorization-server"
		if metadata {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if !metadata && r.URL.Path != "/oauth/authorize" && r.URL.Path != "/oauth/token" && r.URL.Path != "/oauth/register" && r.URL.Path != "/oauth/revoke" {
			oauthFailure(w, 404, "invalid_request")
			return
		}
		method := http.MethodPost
		if metadata || r.URL.Path == "/oauth/authorize" {
			method = http.MethodGet
		}
		if r.Method != method {
			allow := method
			if metadata {
				allow += ", OPTIONS"
			}
			w.Header().Set("Allow", allow)
			oauthFailure(w, 405, "invalid_request")
			return
		}
		if !metadata {
			if origins := r.Header.Values("Origin"); len(origins) != 0 && (len(origins) != 1 || origins[0] != s.origin) {
				oauthFailure(w, 403, "invalid_request")
				return
			}
			kind := "oauth_other"
			switch r.URL.Path {
			case "/oauth/register":
				kind = "oauth_register"
			case "/oauth/authorize":
				kind = "oauth_authorize"
			case "/oauth/token":
				kind = "oauth_token"
			case "/oauth/revoke":
				kind = "oauth_revoke"
			}
			if !s.oauthLimiter.allow(r.RemoteAddr, kind, time.Now()) {
				w.Header().Set("Retry-After", "60")
				oauthFailure(w, 429, "temporarily_unavailable")
				return
			}
		}
		r.Body = http.MaxBytesReader(w, r.Body, oauthBodyLimit)
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		if !metadata {
			s.cleanupOAuth(ctx)
		}
		var err error
		switch r.URL.Path {
		case "/.well-known/oauth-protected-resource/mcp":
			if r.URL.RawQuery != "" || r.URL.ForceQuery {
				oauthFailure(w, 400, "invalid_request")
				return
			}
			respond(w, 200, map[string]any{"resource": s.origin + "/mcp", "authorization_servers": []string{s.origin}, "scopes_supported": []string{oauthScope, "offline_access"}, "bearer_methods_supported": []string{"header"}})
		case "/.well-known/oauth-authorization-server":
			if r.URL.RawQuery != "" || r.URL.ForceQuery {
				oauthFailure(w, 400, "invalid_request")
				return
			}
			respond(w, 200, map[string]any{
				"issuer": s.origin, "authorization_endpoint": s.origin + "/oauth/authorize", "token_endpoint": s.origin + "/oauth/token", "registration_endpoint": s.origin + "/oauth/register", "revocation_endpoint": s.origin + "/oauth/revoke",
				"response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code", "refresh_token"}, "scopes_supported": []string{oauthScope, "offline_access"}, "token_endpoint_auth_methods_supported": []string{"none"}, "revocation_endpoint_auth_methods_supported": []string{"none"}, "code_challenge_methods_supported": []string{"S256"}, "authorization_response_iss_parameter_supported": true,
			})
		case "/oauth/register":
			err = s.registerOAuthClient(w, r)
		case "/oauth/authorize":
			err = s.beginOAuthAuthorization(w, r)
		case "/oauth/token":
			err = s.exchangeOAuthToken(w, r)
		case "/oauth/revoke":
			err = s.revokeOAuthToken(w, r)
		default:
			oauthFailure(w, 404, "invalid_request")
		}
		if err != nil {
			writeOAuthError(w, err)
		}
	})
}

type oauthProtocolError struct {
	status int
	code   string
}

func (e *oauthProtocolError) Error() string { return e.code }
func oauthInvalid(code string) error        { return &oauthProtocolError{400, code} }
func oauthFailure(w http.ResponseWriter, status int, code string) {
	respond(w, status, map[string]string{"error": code})
}
func writeOAuthError(w http.ResponseWriter, err error) {
	var protocol *oauthProtocolError
	if errors.As(err, &protocol) {
		oauthFailure(w, protocol.status, protocol.code)
		return
	}
	// Never forward component hints, database errors, or original parameters.
	if errors.Is(err, fosite.ErrInvalidClient) {
		oauthFailure(w, 400, "invalid_client")
		return
	}
	if errors.Is(err, fosite.ErrInvalidGrant) || errors.Is(err, fosite.ErrTokenExpired) {
		oauthFailure(w, 400, "invalid_grant")
		return
	}
	if errors.Is(err, fosite.ErrInvalidScope) {
		oauthFailure(w, 400, "invalid_scope")
		return
	}
	if errors.Is(err, fosite.ErrInvalidRequest) || errors.Is(err, fosite.ErrInvalidState) || errors.Is(err, fosite.ErrUnsupportedResponseType) {
		oauthFailure(w, 400, "invalid_request")
		return
	}
	oauthFailure(w, 503, "temporarily_unavailable")
}

// Reject duplicate JSON members and nulls before typed decoding. These protocol
// objects contain only finite arrays and flat members, never arbitrary metadata.
func decodeOAuthJSON(r *http.Request, value any) error {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return oauthInvalid("invalid_request")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	var scan func() error
	scan = func() error {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		if t == nil {
			return errors.New("null")
		}
		d, ok := t.(json.Delim)
		if !ok {
			return nil
		}
		if d == '{' {
			seen := map[string]bool{}
			for dec.More() {
				key, e := dec.Token()
				if e != nil {
					return e
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return errors.New("duplicate")
				}
				seen[name] = true
				if e = scan(); e != nil {
					return e
				}
			}
		} else if d == '[' {
			for dec.More() {
				if err := scan(); err != nil {
					return err
				}
			}
		} else {
			return errors.New("delimiter")
		}
		_, err = dec.Token()
		return err
	}
	if err = scan(); err != nil {
		return oauthInvalid("invalid_request")
	}
	if _, err = dec.Token(); !errors.Is(err, io.EOF) {
		return oauthInvalid("invalid_request")
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if err = decodeJSON(r, value); err != nil {
		return oauthInvalid("invalid_request")
	}
	return nil
}

func (s *Service) registerOAuthClient(w http.ResponseWriter, r *http.Request) error {
	if r.URL.RawQuery != "" || r.URL.ForceQuery || len(r.Header.Values("Authorization")) != 0 {
		return oauthInvalid("invalid_client_metadata")
	}
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || (len(params) > 0 && (len(params) != 1 || !strings.EqualFold(params["charset"], "utf-8"))) {
		return oauthInvalid("invalid_client_metadata")
	}
	var body *struct {
		Name            string   `json:"client_name"`
		Redirects       []string `json:"redirect_uris"`
		GrantTypes      []string `json:"grant_types"`
		ResponseTypes   []string `json:"response_types"`
		AuthMethod      string   `json:"token_endpoint_auth_method"`
		ApplicationType string   `json:"application_type"`
		Scope           string   `json:"scope"`
	}
	if err = decodeOAuthJSON(r, &body); err != nil || body == nil {
		return oauthInvalid("invalid_client_metadata")
	}
	name, err := cleanName(body.Name)
	if err != nil || len(body.Redirects) < 1 || len(body.Redirects) > 5 || body.AuthMethod != "none" || (body.ApplicationType != "" && body.ApplicationType != "native") {
		return oauthInvalid("invalid_client_metadata")
	}
	if body.Scope != "" {
		if _, ok := oauthScopes(body.Scope); !ok {
			return oauthInvalid("invalid_client_metadata")
		}
	}
	seen := map[string]bool{}
	for _, redirect := range body.Redirects {
		if _, err := oauthRedirect(redirect); err != nil || seen[redirect] {
			return oauthInvalid("invalid_redirect_uri")
		}
		seen[redirect] = true
	}
	seen = map[string]bool{}
	for _, grant := range body.GrantTypes {
		if (grant != "authorization_code" && grant != "refresh_token") || seen[grant] {
			return oauthInvalid("invalid_client_metadata")
		}
		seen[grant] = true
	}
	if len(body.GrantTypes) > 0 && !seen["authorization_code"] {
		return oauthInvalid("invalid_client_metadata")
	}
	if len(body.ResponseTypes) > 0 && (len(body.ResponseTypes) != 1 || body.ResponseTypes[0] != "code") {
		return oauthInvalid("invalid_client_metadata")
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, oauthAdmissionLock); err != nil {
		return err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM oauth_clients`).Scan(&count); err != nil {
		return err
	}
	if count >= oauthMaxClients {
		return &oauthProtocolError{429, "temporarily_unavailable"}
	}
	redirects, _ := json.Marshal(body.Redirects)
	id := uuid.NewString()
	var created time.Time
	if err = tx.QueryRow(ctx, `INSERT INTO oauth_clients(id,name,redirect_uris,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '90 days') RETURNING created_at`, id, name, redirects).Scan(&created); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	respond(w, 201, map[string]any{"client_id": id, "client_id_issued_at": created.Unix(), "client_name": name, "redirect_uris": body.Redirects, "grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "token_endpoint_auth_method": "none", "application_type": "native", "scope": oauthOfflineScope})
	return nil
}

func (s *Service) beginOAuthAuthorization(w http.ResponseWriter, r *http.Request) error {
	values, err := oauthValues(r, "response_type client_id redirect_uri state code_challenge code_challenge_method resource scope prompt", false)
	if err != nil || values.Get("response_type") != "code" || values.Get("resource") != s.origin+"/mcp" || values.Get("code_challenge_method") != "S256" || !canonicalOAuthHandle(values.Get("code_challenge")) || len(values.Get("state")) < 8 || (values.Get("prompt") != "" && values.Get("prompt") != "consent") {
		return oauthInvalid("invalid_request")
	}
	scope, ok := oauthScopes(values.Get("scope"))
	if !ok {
		return oauthInvalid("invalid_scope")
	}
	values.Set("scope", scope)
	registeredClient, err := (&oauthStore{service: s}).GetClient(r.Context(), values.Get("client_id"))
	if errors.Is(err, fosite.ErrNotFound) {
		return oauthInvalid("invalid_client")
	}
	if err != nil {
		return err
	}
	matched := false
	for _, registered := range registeredClient.GetRedirectURIs() {
		if oauthRedirectMatches(registered, values.Get("redirect_uri")) {
			matched = true
			break
		}
	}
	if !matched {
		return oauthInvalid("invalid_request")
	}
	client, err := s.oauthProvider().NewAuthorizeRequest(r.Context(), oauthFormRequest(r, values, false))
	if err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, oauthAdmissionLock); err != nil {
		return err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM oauth_requests`).Scan(&count); err != nil {
		return err
	}
	if count >= oauthMaxRequests {
		return &oauthProtocolError{429, "temporarily_unavailable"}
	}
	handle := randomToken()
	form, _ := json.Marshal(values)
	if _, err = tx.Exec(ctx, `INSERT INTO oauth_requests(handle_hash,client_id,form,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '10 minutes')`, hashToken(handle), client.GetClient().GetID(), form); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE oauth_clients SET expires_at=clock_timestamp()+interval '90 days' WHERE id=$1`, client.GetClient().GetID()); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	w.Header().Set("Location", s.origin+"/oauth/consent?request="+handle)
	w.WriteHeader(http.StatusFound)
	return nil
}

func oauthFormRequest(r *http.Request, values url.Values, post bool) *http.Request {
	clone := r.Clone(r.Context())
	clone.URL = &url.URL{Path: r.URL.Path}
	clone.Form = values
	if post {
		clone.Method = http.MethodPost
		clone.PostForm = values
	}
	return clone
}

type oauthFamily struct {
	ID         string
	Account    uuid.UUID
	Generation int64
	Client     string
	Scope      string
	Expires    time.Time
}

// First find an identity without a lock, then lock account before grant rows.
// Recovery holds the same account lock. Recheck all authority after acquiring it.
func (s *Service) lockOAuthFamily(ctx context.Context, tx pgx.Tx, signature, kind, client string) (*oauthFamily, time.Time, error) {
	family := &oauthFamily{}
	err := tx.QueryRow(ctx, `SELECT g.id,g.account_id,g.generation FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.signature=$1 AND t.kind=$2`, signature, kind).Scan(&family.ID, &family.Account, &family.Generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, time.Time{}, oauthInvalid("invalid_grant")
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	if _, err = lockAccount(ctx, tx, family.Account, family.Generation); err != nil {
		if errors.Is(err, errGeneration) {
			err = oauthInvalid("invalid_grant")
		}
		return nil, time.Time{}, err
	}
	var now time.Time
	err = tx.QueryRow(ctx, `SELECT client_id,scope,expires_at,clock_timestamp() FROM oauth_grants WHERE id=$1 AND account_id=$2 AND generation=$3 AND issuer=$4 AND resource=$5 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, family.ID, family.Account, family.Generation, s.origin, s.origin+"/mcp").Scan(&family.Client, &family.Scope, &family.Expires, &now)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, time.Time{}, oauthInvalid("invalid_grant")
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	if client != family.Client {
		return nil, time.Time{}, oauthInvalid("invalid_grant")
	}
	return family, now, nil
}

func (s *Service) exchangeOAuthToken(w http.ResponseWriter, r *http.Request) error {
	values, err := oauthValues(r, "grant_type client_id code redirect_uri code_verifier resource refresh_token scope", true)
	if err != nil || values.Get("client_id") == "" || values.Get("resource") != s.origin+"/mcp" {
		return oauthInvalid("invalid_request")
	}
	var kind, signature string
	switch values.Get("grant_type") {
	case "authorization_code":
		if values.Get("refresh_token") != "" || values.Get("redirect_uri") == "" || len(values.Get("code_verifier")) < 43 || len(values.Get("code_verifier")) > 128 {
			return oauthInvalid("invalid_grant")
		}
		kind, signature = "code", oauthTokenSignature("moc_", values.Get("code"))
	case "refresh_token":
		if values.Get("code") != "" || values.Get("redirect_uri") != "" || values.Get("code_verifier") != "" {
			return oauthInvalid("invalid_request")
		}
		kind, signature = "refresh", oauthTokenSignature("mor_", values.Get("refresh_token"))
	default:
		return oauthInvalid("unsupported_grant_type")
	}
	if signature == "" {
		return oauthInvalid("invalid_grant")
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	family, now, err := s.lockOAuthFamily(ctx, tx, signature, kind, values.Get("client_id"))
	if err != nil {
		return err
	}
	if requested := values.Get("scope"); requested != "" {
		normalized, ok := oauthScopes(requested)
		if !ok || normalized != family.Scope {
			return oauthInvalid("invalid_scope")
		}
	}
	ctx, operation := newOAuthContext(ctx, tx, family.ID, family.Account, family.Expires, now)
	provider := s.oauthProvider()
	request, err := provider.NewAccessRequest(ctx, oauthFormRequest(r, values, true), &fosite.DefaultSession{})
	if err != nil {
		if operation.replayed {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return commitErr
			}
		}
		return err
	}
	response, err := provider.NewAccessResponse(ctx, request)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE oauth_clients SET expires_at=clock_timestamp()+interval '90 days' WHERE id=$1`, family.Client); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	provider.WriteAccessResponse(ctx, w, request, response)
	return nil
}

func (s *Service) revokeOAuthToken(w http.ResponseWriter, r *http.Request) error {
	values, err := oauthValues(r, "client_id token token_type_hint", true)
	if err != nil || values.Get("client_id") == "" || values.Get("token") == "" || (values.Get("token_type_hint") != "" && values.Get("token_type_hint") != "access_token" && values.Get("token_type_hint") != "refresh_token") {
		return oauthInvalid("invalid_request")
	}
	token := values.Get("token")
	kind, signature := "access", oauthTokenSignature("moa_", token)
	if signature == "" {
		kind, signature = "refresh", oauthTokenSignature("mor_", token)
	}
	if signature == "" {
		respond(w, 200, struct{}{})
		return nil
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	family, _, err := s.lockOAuthFamily(ctx, tx, signature, kind, values.Get("client_id"))
	var protocol *oauthProtocolError
	if errors.As(err, &protocol) && protocol.code == "invalid_grant" {
		respond(w, 200, struct{}{})
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1`, family.ID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	respond(w, 200, struct{}{})
	return nil
}
