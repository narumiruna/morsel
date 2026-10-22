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
	if _, _, err = s.requestAuth(r, tx, false, false); err != nil {
		return err
	}
	query, err := parseShareQuery(r)
	if err != nil {
		return err
	}
	page, err := share.NewAdminRepository(tx).List(r.Context(), query)
	if errors.Is(err, share.ErrInvalidAdminParams) {
		return failure(400, "invalid_request", "invalid share list parameters")
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, 200, page)
	return nil
}

func parseShareQuery(r *http.Request) (share.AdminListParams, error) {
	p := share.AdminListParams{Status: "all", Limit: 25}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return p, failure(400, "invalid_request", "invalid share list parameters")
	}
	for key, value := range values {
		if len(value) != 1 || value[0] == "" {
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
		case "cursor":
			p.Cursor = value[0]
		default:
			return p, failure(400, "invalid_request", "unknown share list parameter")
		}
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
	if _, _, err = s.requestAuth(r, tx, mutation, mutation); err != nil {
		return err
	}
	id, err := uuid.Parse(value)
	if err != nil || len(value) != 36 {
		return failure(400, "invalid_id", "invalid share ID")
	}
	repository := share.NewAdminRepository(tx)
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
		respond(w, 204, nil)
		return nil
	}
	detail, err := repository.Detail(r.Context(), id)
	if errors.Is(err, share.ErrNotFound) {
		return failure(404, "not_found", "share not found")
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, 200, detail)
	return nil
}
