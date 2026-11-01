package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"time"

	"github.com/ory/fosite"
	"github.com/ory/fosite/handler/oauth2"
)

const (
	oauthCodePrefix    = "moc_"
	oauthAccessPrefix  = "moa_"
	oauthRefreshPrefix = "mor_"
)

type oauthStrategy struct{}

var _ oauth2.CoreStrategy = oauthStrategy{}

// Signatures are hashes of complete, canonical, type-separated credentials.
// An invalid token cannot produce a key accepted by the store.
func oauthTokenSignature(prefix, token string) string {
	if (prefix != oauthCodePrefix && prefix != oauthAccessPrefix && prefix != oauthRefreshPrefix) || len(token) != len(prefix)+43 || !strings.HasPrefix(token, prefix) {
		return ""
	}
	encoded := token[len(prefix):]
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return ""
	}
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}

func oauthTokenExpiry(op *oauthOperation, kind fosite.TokenType) time.Time {
	var lifetime time.Duration
	switch kind {
	case fosite.AuthorizeCode:
		lifetime = oauthCodeLifetime
	case fosite.AccessToken:
		lifetime = oauthAccessLifetime
	case fosite.RefreshToken:
		lifetime = oauthFamilyLifetime
	}
	expires := op.now.Add(lifetime)
	if op.familyExpires.Before(expires) {
		expires = op.familyExpires
	}
	return expires
}

func oauthGenerateToken(ctx context.Context, requester fosite.Requester, prefix string, kind fosite.TokenType) (string, string, error) {
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return "", "", err
	}
	if requester == nil || requester.GetSession() == nil || requester.GetID() != op.grantID || requester.GetSession().GetSubject() != op.accountID.String() {
		return "", "", fosite.ErrServerError
	}
	if !op.now.Before(op.familyExpires) {
		return "", "", fosite.ErrTokenExpired
	}
	requester.GetSession().SetExpiresAt(kind, oauthTokenExpiry(op, kind))
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", fosite.ErrServerError
	}
	token := prefix + base64.RawURLEncoding.EncodeToString(raw)
	return token, oauthTokenSignature(prefix, token), nil
}

func oauthValidateToken(ctx context.Context, requester fosite.Requester, token, prefix string, kind fosite.TokenType) error {
	if oauthTokenSignature(prefix, token) == "" {
		return fosite.ErrInvalidTokenFormat
	}
	op, err := oauthOperationFrom(ctx)
	if err != nil {
		return err
	}
	// During code exchange Fosite validates the access-request prototype before
	// it replaces its request ID. The store has already checked the saved ID.
	if requester == nil || requester.GetSession() == nil || requester.GetSession().GetSubject() != op.accountID.String() {
		return fosite.ErrInvalidGrant
	}
	expires := requester.GetSession().GetExpiresAt(kind)
	if expires.IsZero() || !op.now.Before(expires) || !op.now.Before(op.familyExpires) {
		return fosite.ErrTokenExpired
	}
	return nil
}

func (oauthStrategy) GenerateAuthorizeCode(ctx context.Context, requester fosite.Requester) (string, string, error) {
	return oauthGenerateToken(ctx, requester, oauthCodePrefix, fosite.AuthorizeCode)
}
func (oauthStrategy) GenerateAccessToken(ctx context.Context, requester fosite.Requester) (string, string, error) {
	return oauthGenerateToken(ctx, requester, oauthAccessPrefix, fosite.AccessToken)
}
func (oauthStrategy) GenerateRefreshToken(ctx context.Context, requester fosite.Requester) (string, string, error) {
	return oauthGenerateToken(ctx, requester, oauthRefreshPrefix, fosite.RefreshToken)
}
func (oauthStrategy) AuthorizeCodeSignature(_ context.Context, token string) string {
	return oauthTokenSignature(oauthCodePrefix, token)
}
func (oauthStrategy) AccessTokenSignature(_ context.Context, token string) string {
	return oauthTokenSignature(oauthAccessPrefix, token)
}
func (oauthStrategy) RefreshTokenSignature(_ context.Context, token string) string {
	return oauthTokenSignature(oauthRefreshPrefix, token)
}
func (oauthStrategy) ValidateAuthorizeCode(ctx context.Context, requester fosite.Requester, token string) error {
	return oauthValidateToken(ctx, requester, token, oauthCodePrefix, fosite.AuthorizeCode)
}
func (oauthStrategy) ValidateAccessToken(ctx context.Context, requester fosite.Requester, token string) error {
	return oauthValidateToken(ctx, requester, token, oauthAccessPrefix, fosite.AccessToken)
}
func (oauthStrategy) ValidateRefreshToken(ctx context.Context, requester fosite.Requester, token string) error {
	return oauthValidateToken(ctx, requester, token, oauthRefreshPrefix, fosite.RefreshToken)
}
