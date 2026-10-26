// Package auth implements database-backed API keys and browser passkey sessions.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	sessionCookie         = "morsel_session"
	flowCookie            = "morsel_flow"
	flowLifetime          = 10 * time.Minute
	sessionLifetime       = 30 * 24 * time.Hour
	grantLifetime         = time.Hour
	verifyLifetime        = 12 * time.Hour
	setupLock       int64 = 0x6d6f7273656c
)

type Service struct {
	pool      *pgxpool.Pool
	web       *webauthn.WebAuthn
	origin    string
	publicURL *url.URL
	secure    bool
	limiter   rateLimiter
	cleanupAt atomic.Int64
}

func NewService(pool *pgxpool.Pool, publicURL *url.URL) (*Service, error) {
	if pool == nil || publicURL == nil || publicURL.Hostname() == "" || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" {
		return nil, errors.New("invalid authentication configuration")
	}
	scheme, hostname := strings.ToLower(publicURL.Scheme), strings.ToLower(publicURL.Hostname())
	if scheme != "https" && !(scheme == "http" && hostname == "localhost") {
		return nil, errors.New("authentication requires HTTPS or HTTP localhost")
	}
	port := publicURL.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	host := hostname
	if port != "" {
		host = net.JoinHostPort(hostname, port)
	} else if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	origin := scheme + "://" + host
	resident := true
	web, err := webauthn.New(&webauthn.Config{
		RPID: hostname, RPDisplayName: "Morsel", RPOrigins: []string{origin},
		AuthenticatorSelection: protocol.AuthenticatorSelection{ResidentKey: protocol.ResidentKeyRequirementRequired, RequireResidentKey: &resident, UserVerification: protocol.VerificationRequired},
		Timeouts:               webauthn.TimeoutsConfig{Login: webauthn.TimeoutConfig{Enforce: true, Timeout: flowLifetime}, Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: flowLifetime}},
	})
	if err != nil {
		return nil, fmt.Errorf("configure WebAuthn: %w", err)
	}
	return &Service{pool: pool, web: web, origin: origin, publicURL: publicURL, secure: scheme == "https"}, nil
}

func randomToken() string { return base64.RawURLEncoding.EncodeToString(randomBytes(32)) }
func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}
func hashToken(token string) []byte { h := sha256.Sum256([]byte(token)); return h[:] }

// Authenticate checks PostgreSQL on every request. Invalid keys return uuid.Nil;
// database errors never return an authorized identity.
func (s *Service) Authenticate(ctx context.Context, header string) (uuid.UUID, error) {
	parts := strings.Split(header, " ")
	if len(parts) != 2 || parts[0] != "Bearer" || len(parts[1]) < 32 || len(parts[1]) > 256 {
		return uuid.Nil, nil
	}
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT account_id FROM api_keys WHERE token_hash=$1 AND revoked_at IS NULL`, hashToken(parts[1])).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	if err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

type apiError struct {
	status        int
	code, message string
}

func (e *apiError) Error() string                    { return e.message }
func failure(status int, code, message string) error { return &apiError{status, code, message} }

var (
	errUnauthorized = failure(401, "unauthorized", "browser session required")
	errFlow         = failure(400, "invalid_flow", "authentication flow expired or invalid")
	errCredential   = failure(400, "invalid_credential", "passkey verification failed")
	errGrant        = failure(403, "invalid_grant", "operator grant expired or invalid")
	errGeneration   = failure(401, "authentication_changed", "authentication changed; sign in again")
	errFresh        = failure(403, "verification_required", "fresh passkey verification required")
)

func respond(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	if value != nil {
		_ = json.NewEncoder(w).Encode(value)
	}
}
func respondError(w http.ResponseWriter, err error) {
	var e *apiError
	if !errors.As(err, &e) {
		e = &apiError{503, "unavailable", "authentication service unavailable"}
	}
	respond(w, e.status, map[string]string{"code": e.code, "message": e.message})
}
func (s *Service) cookie(w http.ResponseWriter, name, value string, remove bool) {
	c := &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteLaxMode}
	if name == sessionCookie && !remove {
		c.MaxAge = int(sessionLifetime / time.Second)
		c.Expires = time.Now().Add(sessionLifetime).UTC()
	}
	if remove {
		c.MaxAge = -1
		c.Expires = time.Unix(1, 0)
	}
	http.SetCookie(w, c)
}
func cookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil || len(c.Value) > 256 {
		return ""
	}
	return c.Value
}
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return failure(400, "invalid_json", "valid JSON body required")
	}
	var extra any
	if err := dec.Decode(&extra); err == nil || !errors.Is(err, io.EOF) {
		return failure(400, "invalid_json", "one JSON value required")
	}
	return nil
}
