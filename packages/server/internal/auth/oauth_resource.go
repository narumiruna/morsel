package auth

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) MCPResourceMetadataURL() string {
	return s.origin + "/.well-known/oauth-protected-resource/mcp"
}

// AuthenticateMCP is the only dual-credential entry point. REST continues using
// Authenticate, so an OAuth token cannot acquire REST or account permissions.
// Insufficient scope is distinguished only for otherwise valid access tokens.
func (s *Service) AuthenticateMCP(ctx context.Context, header string) (uuid.UUID, bool, error) {
	parts := strings.Split(header, " ")
	if len(parts) != 2 || parts[0] != "Bearer" {
		return uuid.Nil, false, nil
	}
	token := parts[1]
	if !strings.HasPrefix(token, oauthAccessPrefix) {
		if strings.HasPrefix(token, oauthCodePrefix) || strings.HasPrefix(token, oauthRefreshPrefix) {
			return uuid.Nil, false, nil
		}
		id, err := s.Authenticate(ctx, header)
		return id, false, err
	}
	signature := oauthTokenSignature(oauthAccessPrefix, token)
	if signature == "" {
		return uuid.Nil, false, nil
	}
	var id uuid.UUID
	var scope string
	err := s.pool.QueryRow(ctx, `SELECT g.account_id,g.scope FROM oauth_tokens t
		JOIN oauth_grants g ON g.id=t.grant_id JOIN accounts a ON a.id=g.account_id
		WHERE t.signature=$1 AND t.kind='access' AND t.active AND t.expires_at>clock_timestamp()
		AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND a.auth_generation=g.generation
		AND g.issuer=$2 AND g.resource=$3`, signature, s.origin, s.origin+"/mcp").Scan(&id, &scope)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	for _, permission := range strings.Fields(scope) {
		if permission == oauthScope {
			return id, false, nil
		}
	}
	return uuid.Nil, true, nil
}
