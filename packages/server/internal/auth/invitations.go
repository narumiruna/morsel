package auth

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// requireSignedOut does not clear cookies or spend grants. An expired or invalid
// session can enroll, but database failures must never permit registration.
// The caller holds any acquired account/session locks through its commit.
func (s *Service) requireSignedOut(r *http.Request, tx pgx.Tx) error {
	_, _, err := s.requestAuth(r, tx, false, false)
	if err == nil {
		return failure(409, "sign_out_required", "sign out or use a private window, then reopen the invitation link")
	}
	if errors.Is(err, errUnauthorized) || errors.Is(err, errGeneration) {
		return nil
	}
	return err
}

func (s *Service) createInvitation(w http.ResponseWriter, r *http.Request) error {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		return failure(400, "invalid_query", "query parameters are not allowed")
	}
	var body *struct{}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if body == nil {
		return failure(400, "invalid_json", "empty JSON object required")
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	u, _, err := s.requestAuth(r, tx, true, true)
	if err != nil {
		return err
	}
	if u.Role != "admin" {
		return failure(403, "forbidden", "admin account required")
	}
	if !s.limiter.allow(r.RemoteAddr, "invite_issue", time.Now()) {
		w.Header().Set("Retry-After", "60")
		return failure(429, "rate_limited", "too many invitation requests")
	}
	token, expires, err := insertGrant(r.Context(), tx, "invite", nil, nil)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	link := *s.publicURL
	link.Path, link.RawPath = "/invite", ""
	link.RawQuery, link.ForceQuery = "", false
	link.Fragment, link.RawFragment = "token="+token, ""
	w.Header().Set("X-Morsel-Account-ID", u.ID.String())
	respond(w, 201, struct {
		InvitationURL string    `json:"invitation_url"`
		ExpiresAt     time.Time `json:"expires_at"`
	}{link.String(), expires})
	return nil
}
