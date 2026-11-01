package auth

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/ory/fosite"
	"github.com/ory/fosite/compose"
)

const (
	oauthCodeLifetime   = time.Minute
	oauthAccessLifetime = 10 * time.Minute
	oauthFamilyLifetime = 30 * 24 * time.Hour
)

// The application owns this transaction and holds the account lock before the
// grant lock. It commits only after the complete component operation succeeds,
// or after a detected replay has successfully revoked the family.
type oauthOperation struct {
	tx             pgx.Tx
	grantID        string
	accountID      uuid.UUID
	familyExpires  time.Time
	now            time.Time
	replayed       bool
	replayDetected bool
}

type oauthOperationKey struct{}

func newOAuthContext(ctx context.Context, tx pgx.Tx, grantID string, accountID uuid.UUID, familyExpires, now time.Time) (context.Context, *oauthOperation) {
	op := &oauthOperation{tx: tx, grantID: grantID, accountID: accountID, familyExpires: familyExpires, now: now}
	return context.WithValue(ctx, oauthOperationKey{}, op), op
}

func oauthOperationFrom(ctx context.Context) (*oauthOperation, error) {
	op, ok := ctx.Value(oauthOperationKey{}).(*oauthOperation)
	if !ok || op == nil || op.tx == nil || op.accountID == uuid.Nil || op.now.IsZero() || op.familyExpires.IsZero() {
		return nil, fosite.ErrServerError
	}
	id, err := uuid.Parse(op.grantID)
	if err != nil || id == uuid.Nil {
		return nil, fosite.ErrServerError
	}
	return op, nil
}

// Fosite configuration has lazy defaults. Build it per operation instead of
// sharing mutable configuration between requests. No signing secret is needed
// for the random opaque strategy.
func (s *Service) oauthProvider() fosite.OAuth2Provider {
	resource := s.origin + "/mcp"
	config := &fosite.Config{
		AuthorizeCodeLifespan:          oauthCodeLifetime,
		AccessTokenLifespan:            oauthAccessLifetime,
		RefreshTokenLifespan:           oauthFamilyLifetime,
		EnforcePKCE:                    true,
		EnforcePKCEForPublicClients:    true,
		EnablePKCEPlainChallengeMethod: false,
		RefreshTokenScopes:             []string{"offline_access"},
		ScopeStrategy:                  fosite.ExactScopeStrategy,
		AudienceMatchingStrategy: func(allowed, requested []string) error {
			if len(allowed) != 1 || allowed[0] != resource || len(requested) > 1 {
				return fosite.ErrInvalidRequest
			}
			for _, audience := range requested {
				if audience != resource {
					return fosite.ErrInvalidRequest
				}
			}
			return nil
		},
		SanitationWhiteList: []string{"grant_type", "response_type", "scope", "client_id", "redirect_uri", "code_challenge", "code_challenge_method"},
	}
	return oauthClockProvider{compose.Compose(config, &oauthStore{service: s}, oauthStrategy{},
		compose.OAuth2AuthorizeExplicitFactory,
		compose.OAuth2RefreshTokenGrantFactory,
		compose.OAuth2PKCEFactory,
	)}
}

type oauthClockProvider struct{ fosite.OAuth2Provider }

func (p oauthClockProvider) NewAccessResponse(ctx context.Context, request fosite.AccessRequester) (fosite.AccessResponder, error) {
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return nil, err
	}
	response, err := p.OAuth2Provider.NewAccessResponse(ctx, request)
	if err != nil {
		return nil, err
	}
	// Fosite otherwise calculates expires_in against the host wall clock.
	response.SetExpiresIn(max(0, request.GetSession().GetExpiresAt(fosite.AccessToken).Sub(op.now)))
	return response, nil
}

func oauthPublicClient(origin, id string, redirects []string) *fosite.DefaultClient {
	return &fosite.DefaultClient{
		ID:            id,
		RedirectURIs:  append([]string(nil), redirects...),
		GrantTypes:    []string{"authorization_code", "refresh_token"},
		ResponseTypes: []string{"code"},
		Scopes:        []string{"mcp:shares", "offline_access"},
		Audience:      []string{origin + "/mcp"},
		Public:        true,
	}
}
