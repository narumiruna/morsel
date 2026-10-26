package auth

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/share"
)

func (s *Service) listShares(w http.ResponseWriter, r *http.Request) error {
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	u, _, err := s.requestAuth(r, tx, false, false)
	if err != nil {
		return err
	}
	query, err := parseShareQuery(r)
	if err != nil {
		return err
	}
	page, err := share.NewAdminRepository(tx, u.ID).List(r.Context(), query)
	if errors.Is(err, share.ErrLabelBackfillRequired) {
		return failure(503, "label_backfill_required", "share labels are not ready")
	}
	if errors.Is(err, share.ErrInvalidAdminParams) {
		return failure(400, "invalid_request", "invalid share list parameters")
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("X-Morsel-Account-ID", u.ID.String())
	respond(w, 200, page)
	return nil
}

func (s *Service) getShareLink(w http.ResponseWriter, r *http.Request, value string) error {
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	u, _, err := s.requestAuth(r, tx, false, false)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(value)
	if err != nil || len(value) != 36 {
		return failure(400, "invalid_id", "invalid share ID")
	}
	token, preview, err := share.NewAdminRepository(tx, u.ID).Link(r.Context(), id)
	if errors.Is(err, share.ErrLinkUnavailable) {
		return failure(404, "link_unavailable", "The original link was not saved. Existing public URLs are unchanged.")
	}
	if errors.Is(err, share.ErrNotFound) {
		return failure(404, "not_found", "share not found")
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("X-Morsel-Account-ID", u.ID.String())
	respond(w, 200, map[string]string{"share_url": share.PublicURL(s.publicURL, token, preview)})
	return nil
}

// verifyShareLink returns only a URL whose capability the owner already supplied.
// It does not retain the capability or change public availability.
func (s *Service) verifyShareLink(w http.ResponseWriter, r *http.Request, value string) error {
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	u, _, err := s.requestAuth(r, tx, true, false)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(value)
	if err != nil || len(value) != 36 {
		return failure(400, "invalid_id", "invalid share ID")
	}
	var body struct {
		Token string `json:"token"`
	}
	if err = decodeJSON(r, &body); err != nil {
		return err
	}
	hash, err := share.HashToken(body.Token)
	if err != nil {
		return failure(400, "invalid_request", "invalid share token")
	}
	preview, err := share.NewAdminRepository(tx, u.ID).VerifyToken(r.Context(), id, hash)
	if errors.Is(err, share.ErrNotFound) {
		return failure(404, "link_mismatch", "This public link does not belong to this share.")
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("X-Morsel-Account-ID", u.ID.String())
	respond(w, 200, map[string]string{"share_url": share.PublicURL(s.publicURL, body.Token, preview)})
	return nil
}

func parseShareQuery(r *http.Request) (share.AdminListParams, error) {
	p := share.AdminListParams{Status: "all", Limit: 25}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return p, failure(400, "invalid_request", "invalid share list parameters")
	}
	for key, value := range values {
		if len(value) != 1 || (value[0] == "" && key != "q") {
			return p, failure(400, "invalid_request", "invalid share list parameters")
		}
		switch key {
		case "status":
			p.Status = value[0]
			if !share.ValidAdminStatus(p.Status) {
				return p, failure(400, "invalid_request", "invalid share status")
			}
		case "limit":
			limit, err := strconv.Atoi(value[0])
			if err != nil || limit < 1 || limit > 100 {
				return p, failure(400, "invalid_request", "limit must be between 1 and 100")
			}
			p.Limit = limit
		case "q":
			p.Q = value[0]
		case "sort":
			p.Sort = value[0]
		case "cursor":
			p.Cursor = value[0]
		default:
			return p, failure(400, "invalid_request", "unknown share list parameter")
		}
	}
	p, err = share.NormalizeAdminQuery(p)
	if err != nil {
		return p, failure(400, "invalid_request", "invalid share list parameters")
	}
	return p, nil
}

func (s *Service) manageShare(w http.ResponseWriter, r *http.Request, value string) error {
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	mutation := r.Method == http.MethodDelete
	u, _, err := s.requestAuth(r, tx, mutation, mutation)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(value)
	if err != nil || len(value) != 36 {
		return failure(400, "invalid_id", "invalid share ID")
	}
	repository := share.NewAdminRepository(tx, u.ID)
	if mutation {
		found, err := repository.Revoke(r.Context(), id)
		if err != nil {
			return err
		}
		if !found {
			return failure(404, "not_found", "share not found")
		}
		if err = tx.Commit(r.Context()); err != nil {
			return err
		}
		w.Header().Set("X-Morsel-Account-ID", u.ID.String())
		respond(w, 204, nil)
		return nil
	}
	detail, err := repository.Detail(r.Context(), id)
	if errors.Is(err, share.ErrLabelBackfillRequired) {
		return failure(503, "label_backfill_required", "share labels are not ready")
	}
	if errors.Is(err, share.ErrNotFound) {
		return failure(404, "not_found", "share not found")
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("X-Morsel-Account-ID", u.ID.String())
	respond(w, 200, detail)
	return nil
}
