package auth

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/ory/fosite"
	"github.com/ory/fosite/handler/oauth2"
	"github.com/ory/fosite/handler/pkce"
)

const oauthTokenLimit = 10000

// oauthStore deliberately does not implement storage.Transactional. Fosite must
// not commit the application's outer transaction, including PKCE deletion.
type oauthStore struct{ service *Service }

var (
	_ fosite.Storage                = (*oauthStore)(nil)
	_ oauth2.CoreStorage            = (*oauthStore)(nil)
	_ oauth2.TokenRevocationStorage = (*oauthStore)(nil)
	_ pkce.PKCERequestStorage       = (*oauthStore)(nil)
)

func (s *oauthStore) GetClient(ctx context.Context, id string) (fosite.Client, error) {
	clientID, err := uuid.Parse(id)
	if err != nil || clientID == uuid.Nil {
		return nil, fosite.ErrNotFound
	}
	var data []byte
	if op, ok := ctx.Value(oauthOperationKey{}).(*oauthOperation); ok {
		if op == nil || op.tx == nil || op.now.IsZero() {
			return nil, fosite.ErrServerError
		}
		err = op.tx.QueryRow(ctx, `SELECT redirect_uris FROM oauth_clients WHERE id=$1 AND expires_at>$2`, clientID, op.now).Scan(&data)
	} else {
		err = s.service.pool.QueryRow(ctx, `SELECT redirect_uris FROM oauth_clients WHERE id=$1 AND expires_at>clock_timestamp()`, clientID).Scan(&data)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fosite.ErrNotFound
	}
	if err != nil {
		return nil, fosite.ErrServerError
	}
	var redirects []string
	if err := json.Unmarshal(data, &redirects); err != nil || len(redirects) == 0 {
		return nil, fosite.ErrServerError
	}
	// The application validates the exact redirect form, including its narrow
	// native loopback-port exception, before it calls NewAuthorizeRequest.
	return oauthPublicClient(s.service.origin, clientID.String(), redirects), nil
}

// Public native clients do not support JWT client assertions.
func (*oauthStore) ClientAssertionJWTValid(context.Context, string) error {
	return fosite.ErrInvalidClient
}
func (*oauthStore) SetClientAssertionJWT(context.Context, string, time.Time) error {
	return fosite.ErrInvalidClient
}

func oauthValidSignature(signature string) bool {
	if len(signature) != 64 {
		return false
	}
	raw, err := hex.DecodeString(signature)
	return err == nil && hex.EncodeToString(raw) == signature
}

func oauthValidScopes(scopes fosite.Arguments) bool {
	if len(scopes) < 1 || len(scopes) > 2 || !scopes.Has("mcp:shares") {
		return false
	}
	seen := make(map[string]bool, len(scopes))
	for _, scope := range scopes {
		if (scope != "mcp:shares" && scope != "offline_access") || seen[scope] {
			return false
		}
		seen[scope] = true
	}
	return true
}

func (s *oauthStore) validateRequest(op *oauthOperation, request fosite.Requester) error {
	if request == nil || request.GetID() != op.grantID || request.GetSession() == nil || request.GetSession().GetSubject() != op.accountID.String() || request.GetClient() == nil {
		return fosite.ErrServerError
	}
	clientID, err := uuid.Parse(request.GetClient().GetID())
	if err != nil || clientID == uuid.Nil || !request.GetClient().IsPublic() {
		return fosite.ErrServerError
	}
	requested, granted := request.GetRequestedScopes(), request.GetGrantedScopes()
	if !oauthValidScopes(requested) || !oauthValidScopes(granted) {
		return fosite.ErrServerError
	}
	for _, scope := range granted {
		if !requested.Has(scope) {
			return fosite.ErrServerError
		}
	}
	resource := s.service.origin + "/mcp"
	if !request.GetRequestedAudience().ExactOne(resource) || !request.GetGrantedAudience().ExactOne(resource) {
		return fosite.ErrServerError
	}
	return nil
}

func oauthSavedForm(form url.Values) (url.Values, error) {
	saved := make(url.Values)
	for _, name := range []string{"grant_type", "response_type", "scope", "client_id", "redirect_uri", "code_challenge", "code_challenge_method"} {
		if values, ok := form[name]; ok {
			if len(values) != 1 || len(values[0]) > 2048 {
				return nil, fosite.ErrServerError
			}
			saved.Set(name, values[0])
		}
	}
	return saved, nil
}

func (s *oauthStore) marshalRequest(op *oauthOperation, request fosite.Requester) ([]byte, error) {
	if err := s.validateRequest(op, request); err != nil {
		return nil, err
	}
	form, err := oauthSavedForm(request.GetRequestForm())
	if err != nil {
		return nil, err
	}
	// Construct concrete safe types. Do not serialize arbitrary client secrets,
	// session extras, or fields from protocol request wrappers.
	session := &fosite.DefaultSession{Subject: op.accountID.String(), ExpiresAt: make(map[fosite.TokenType]time.Time)}
	for _, kind := range []fosite.TokenType{fosite.AuthorizeCode, fosite.AccessToken, fosite.RefreshToken} {
		expires := request.GetSession().GetExpiresAt(kind)
		if !expires.IsZero() {
			if op.familyExpires.Before(expires) {
				expires = op.familyExpires
			}
			session.SetExpiresAt(kind, expires)
		}
	}
	saved := &fosite.Request{
		ID:                op.grantID,
		RequestedAt:       request.GetRequestedAt(),
		Client:            oauthPublicClient(s.service.origin, request.GetClient().GetID(), request.GetClient().GetRedirectURIs()),
		RequestedScope:    request.GetRequestedScopes(),
		GrantedScope:      request.GetGrantedScopes(),
		Form:              form,
		Session:           session,
		RequestedAudience: request.GetRequestedAudience(),
		GrantedAudience:   request.GetGrantedAudience(),
	}
	data, err := json.Marshal(saved)
	if err != nil {
		return nil, fosite.ErrServerError
	}
	return data, nil
}

func (s *oauthStore) createToken(ctx context.Context, signature, kind string, tokenType fosite.TokenType, request fosite.Requester) error {
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return err
	}
	if !oauthValidSignature(signature) {
		return fosite.ErrServerError
	}
	if err := s.validateRequest(op, request); err != nil {
		return err
	}
	if !op.now.Before(op.familyExpires) {
		return fosite.ErrNotFound
	}
	// Fosite writes wall-clock expiries after GenerateAuthorizeCode, and slides
	// refresh expiry. Replace both with the authoritative operation clock.
	expires := oauthTokenExpiry(op, tokenType)
	request.GetSession().SetExpiresAt(tokenType, expires)
	data, err := s.marshalRequest(op, request)
	if err != nil {
		return err
	}
	// The application already holds the grant lock. The bound includes inactive
	// tombstones, which must remain until absolute family expiration.
	tag, err := op.tx.Exec(ctx, `INSERT INTO oauth_tokens(signature,kind,grant_id,active,request_data,expires_at)
		SELECT $1,$2,g.id,true,$3,$4 FROM oauth_grants g
		WHERE g.id=$5 AND g.account_id=$6 AND g.revoked_at IS NULL AND g.expires_at=$7 AND g.expires_at>$8
		AND (SELECT count(*) FROM oauth_tokens WHERE grant_id=g.id)<$9`,
		signature, kind, data, expires, op.grantID, op.accountID, op.familyExpires, op.now, oauthTokenLimit)
	if err != nil || tag.RowsAffected() != 1 {
		return fosite.ErrServerError
	}
	return nil
}

func (s *oauthStore) getToken(ctx context.Context, signature, kind string, tokenType fosite.TokenType, session fosite.Session) (fosite.Requester, error) {
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return nil, err
	}
	if !oauthValidSignature(signature) || !op.now.Before(op.familyExpires) {
		return nil, fosite.ErrNotFound
	}
	var data []byte
	var active bool
	var expires time.Time
	err = op.tx.QueryRow(ctx, `SELECT t.request_data,t.active,LEAST(t.expires_at,g.expires_at) FROM oauth_tokens t
		JOIN oauth_grants g ON g.id=t.grant_id
		WHERE t.signature=$1 AND t.kind=$2 AND t.grant_id=$3 AND g.account_id=$4
		AND g.revoked_at IS NULL AND g.expires_at=$5 AND g.expires_at>$6`,
		signature, kind, op.grantID, op.accountID, op.familyExpires, op.now).Scan(&data, &active, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fosite.ErrNotFound
	}
	if err != nil {
		return nil, fosite.ErrServerError
	}
	request := &fosite.Request{Client: &fosite.DefaultClient{}, Session: &fosite.DefaultSession{}}
	if err := json.Unmarshal(data, request); err != nil {
		return nil, fosite.ErrServerError
	}
	if err := s.validateRequest(op, request); err != nil {
		return nil, err
	}
	saved, ok := request.GetSession().(*fosite.DefaultSession)
	if !ok || saved == nil {
		return nil, fosite.ErrServerError
	}
	// Expiration columns, not serialized metadata, are authoritative.
	saved.SetExpiresAt(tokenType, expires)
	if session != nil {
		target, ok := session.(*fosite.DefaultSession)
		if !ok || target == nil {
			return nil, fosite.ErrServerError
		}
		*target = *saved
		request.SetSession(target)
	}
	if !active {
		switch kind {
		case "code":
			op.replayDetected = true
			return request, fosite.ErrInvalidatedAuthorizeCode
		case "refresh":
			op.replayDetected = true
			return request, fosite.ErrInactiveToken
		default:
			return nil, fosite.ErrNotFound
		}
	}
	if !op.now.Before(expires) {
		return nil, fosite.ErrNotFound
	}
	return request, nil
}

func (s *oauthStore) CreateAuthorizeCodeSession(ctx context.Context, signature string, request fosite.Requester) error {
	return s.createToken(ctx, signature, "code", fosite.AuthorizeCode, request)
}
func (s *oauthStore) GetAuthorizeCodeSession(ctx context.Context, signature string, session fosite.Session) (fosite.Requester, error) {
	return s.getToken(ctx, signature, "code", fosite.AuthorizeCode, session)
}
func (s *oauthStore) CreateAccessTokenSession(ctx context.Context, signature string, request fosite.Requester) error {
	return s.createToken(ctx, signature, "access", fosite.AccessToken, request)
}
func (s *oauthStore) GetAccessTokenSession(ctx context.Context, signature string, session fosite.Session) (fosite.Requester, error) {
	return s.getToken(ctx, signature, "access", fosite.AccessToken, session)
}
func (s *oauthStore) CreateRefreshTokenSession(ctx context.Context, signature, accessSignature string, request fosite.Requester) error {
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return err
	}
	if !oauthValidSignature(accessSignature) {
		return fosite.ErrServerError
	}
	var accessExists bool
	if err := op.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM oauth_tokens WHERE signature=$1 AND kind='access' AND grant_id=$2 AND active AND expires_at>$3)`, accessSignature, op.grantID, op.now).Scan(&accessExists); err != nil || !accessExists {
		return fosite.ErrServerError
	}
	return s.createToken(ctx, signature, "refresh", fosite.RefreshToken, request)
}
func (s *oauthStore) GetRefreshTokenSession(ctx context.Context, signature string, session fosite.Session) (fosite.Requester, error) {
	return s.getToken(ctx, signature, "refresh", fosite.RefreshToken, session)
}
func (s *oauthStore) CreatePKCERequestSession(ctx context.Context, signature string, request fosite.Requester) error {
	return s.createToken(ctx, signature, "pkce", fosite.AuthorizeCode, request)
}
func (s *oauthStore) GetPKCERequestSession(ctx context.Context, signature string, session fosite.Session) (fosite.Requester, error) {
	return s.getToken(ctx, signature, "pkce", fosite.AuthorizeCode, session)
}

func oauthDeactivateToken(ctx context.Context, signature, kind string, requireActive bool) error {
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return err
	}
	if !oauthValidSignature(signature) {
		return fosite.ErrNotFound
	}
	tag, err := op.tx.Exec(ctx, `UPDATE oauth_tokens SET active=false WHERE signature=$1 AND kind=$2 AND grant_id=$3
		AND (NOT $4::boolean OR (active AND expires_at>$5))
		AND EXISTS(SELECT 1 FROM oauth_grants g WHERE g.id=oauth_tokens.grant_id AND g.account_id=$6
		AND g.revoked_at IS NULL AND g.expires_at=$7 AND g.expires_at>$5)`,
		signature, kind, op.grantID, requireActive, op.now, op.accountID, op.familyExpires)
	if err != nil {
		return fosite.ErrServerError
	}
	if tag.RowsAffected() != 1 {
		return fosite.ErrNotFound
	}
	return nil
}

func (*oauthStore) InvalidateAuthorizeCodeSession(ctx context.Context, signature string) error {
	return oauthDeactivateToken(ctx, signature, "code", true)
}
func (*oauthStore) DeleteAccessTokenSession(ctx context.Context, signature string) error {
	return oauthDeactivateToken(ctx, signature, "access", false)
}
func (*oauthStore) DeleteRefreshTokenSession(ctx context.Context, signature string) error {
	// Fosite calls this on reuse. Keep the consumed credential's tombstone.
	return oauthDeactivateToken(ctx, signature, "refresh", false)
}
func (*oauthStore) DeletePKCERequestSession(ctx context.Context, signature string) error {
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return err
	}
	if !oauthValidSignature(signature) {
		return fosite.ErrNotFound
	}
	tag, err := op.tx.Exec(ctx, `DELETE FROM oauth_tokens WHERE signature=$1 AND kind='pkce' AND grant_id=$2
		AND EXISTS(SELECT 1 FROM oauth_grants g WHERE g.id=oauth_tokens.grant_id AND g.account_id=$3
		AND g.revoked_at IS NULL AND g.expires_at=$4 AND g.expires_at>$5)`, signature, op.grantID, op.accountID, op.familyExpires, op.now)
	if err != nil {
		return fosite.ErrServerError
	}
	if tag.RowsAffected() != 1 {
		return fosite.ErrNotFound
	}
	return nil
}

func (*oauthStore) RotateRefreshToken(ctx context.Context, requestID, signature string) error {
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return err
	}
	if requestID != op.grantID || !op.now.Before(op.familyExpires) {
		return fosite.ErrNotFound
	}
	if err := oauthDeactivateToken(ctx, signature, "refresh", true); err != nil {
		return err
	}
	if _, err := op.tx.Exec(ctx, `UPDATE oauth_tokens SET active=false WHERE grant_id=$1 AND kind='access' AND active`, op.grantID); err != nil {
		return fosite.ErrServerError
	}
	return nil
}

func oauthRevokeFamily(ctx context.Context, requestID string) error {
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return err
	}
	if requestID != op.grantID {
		return fosite.ErrNotFound
	}
	tag, err := op.tx.Exec(ctx, `UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND account_id=$2`, op.grantID, op.accountID, op.now)
	if err != nil {
		return fosite.ErrServerError
	}
	if tag.RowsAffected() != 1 {
		return fosite.ErrNotFound
	}
	if _, err := op.tx.Exec(ctx, `UPDATE oauth_tokens SET active=false WHERE grant_id=$1`, op.grantID); err != nil {
		return fosite.ErrServerError
	}
	if op.replayDetected {
		op.replayed = true
	}
	return nil
}

func (*oauthStore) RevokeAccessToken(ctx context.Context, requestID string) error {
	return oauthRevokeFamily(ctx, requestID)
}
func (*oauthStore) RevokeRefreshToken(ctx context.Context, requestID string) error {
	return oauthRevokeFamily(ctx, requestID)
}
