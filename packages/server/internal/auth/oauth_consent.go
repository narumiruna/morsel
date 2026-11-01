package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/ory/fosite"
)

var errOAuthRequest = failure(409, "oauth_request_invalid", "This connection request is no longer valid. Restart the connection from your app.")

type oauthConsent struct {
	ClientID     string    `json:"client_id"`
	ClientName   string    `json:"client_name"`
	RedirectHost string    `json:"redirect_host"`
	Resource     string    `json:"resource"`
	Scope        string    `json:"scope"`
	Expires      time.Time `json:"expires_at"`
	AccountID    string    `json:"account_id"`
}

// A read can bind a request to a session but never create a grant or code.
// Account locks precede pending-request locks, as in every browser mutation.
func (s *Service) oauthConsentRequest(w http.ResponseWriter, r *http.Request, handle string) error {
	if !canonicalOAuthHandle(handle) || r.URL.RawQuery != "" || r.URL.ForceQuery {
		return errOAuthRequest
	}
	var decision *struct {
		Approve   *bool  `json:"approve"`
		AccountID string `json:"account_id"`
	}
	mutation := r.Method == http.MethodPost
	if mutation {
		if err := decodeOAuthJSON(r, &decision); err != nil || decision == nil || decision.Approve == nil {
			return failure(400, "invalid_request", "valid consent decision required")
		}
		if id, err := uuid.Parse(decision.AccountID); err != nil || id == uuid.Nil || id.String() != decision.AccountID {
			return failure(400, "invalid_request", "valid displayed account ID required")
		}
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	u, ss, err := s.requestAuth(r, tx, mutation, mutation && *decision.Approve)
	if err != nil {
		return err
	}
	if mutation && decision.AccountID != u.ID.String() {
		return errOAuthRequest
	}
	var raw []byte
	var clientID, name string
	var boundAccount *uuid.UUID
	var boundGeneration *int64
	var boundSession []byte
	var expires, now time.Time
	err = tx.QueryRow(ctx, `SELECT q.form,q.client_id,c.name,q.account_id,q.generation,q.session_hash,q.expires_at,clock_timestamp() FROM oauth_requests q JOIN oauth_clients c ON c.id=q.client_id WHERE q.handle_hash=$1 AND q.expires_at>clock_timestamp() AND c.expires_at>clock_timestamp() FOR UPDATE OF q`, hashToken(handle)).Scan(&raw, &clientID, &name, &boundAccount, &boundGeneration, &boundSession, &expires, &now)
	if errors.Is(err, pgx.ErrNoRows) {
		return errOAuthRequest
	}
	if err != nil {
		return err
	}
	if boundAccount != nil {
		if *boundAccount != u.ID || boundGeneration == nil || *boundGeneration != u.Generation || !bytes.Equal(boundSession, ss.Hash) {
			return errOAuthRequest
		}
	} else {
		// Approval cannot bind an unseen request: only GET can establish the
		// account/session that the consent page must display.
		if mutation {
			return errOAuthRequest
		}
		if _, err = tx.Exec(ctx, `UPDATE oauth_requests SET account_id=$2,generation=$3,session_hash=$4 WHERE handle_hash=$1`, hashToken(handle), u.ID, u.Generation, ss.Hash); err != nil {
			return err
		}
	}
	var form url.Values
	if err = json.Unmarshal(raw, &form); err != nil {
		return err
	}
	redirect, err := oauthRedirect(form.Get("redirect_uri"))
	if err != nil {
		return errOAuthRequest
	}
	if !mutation {
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		w.Header().Set("X-Morsel-Account-ID", u.ID.String())
		respond(w, 200, oauthConsent{clientID, name, redirect.Host, form.Get("resource"), form.Get("scope"), expires, u.ID.String()})
		return nil
	}
	query := redirect.Query()
	query.Set("state", form.Get("state"))
	query.Set("iss", s.origin)
	if !*decision.Approve {
		query.Set("error", "access_denied")
	} else {
		if form.Get("resource") != s.origin+"/mcp" {
			return errOAuthRequest
		}
		if _, ok := oauthScopes(form.Get("scope")); !ok {
			return errOAuthRequest
		}
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, oauthAdmissionLock); err != nil {
			return err
		}
		var total, owned int
		if err = tx.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE account_id=$1) FROM oauth_grants`, u.ID).Scan(&total, &owned); err != nil {
			return err
		}
		if total >= oauthMaxGrants || owned >= oauthMaxAccountGrants {
			return failure(429, "rate_limited", "connected app capacity reached; expired connections must be cleared before a new connection can be made")
		}
		id := uuid.NewString()
		familyExpiry := now.Add(oauthFamilyLifetime)
		if form.Get("scope") == oauthScope {
			familyExpiry = now.Add(oauthAccessLifetime)
		}
		ctx, _ = newOAuthContext(ctx, tx, id, u.ID, familyExpiry, now)
		provider := s.oauthProvider()
		registeredClient, err := (&oauthStore{service: s}).GetClient(ctx, clientID)
		if err != nil {
			return err
		}
		matched := false
		for _, registered := range registeredClient.GetRedirectURIs() {
			if oauthRedirectMatches(registered, form.Get("redirect_uri")) {
				matched = true
				break
			}
		}
		if !matched {
			return errOAuthRequest
		}
		request, err := provider.NewAuthorizeRequest(ctx, oauthFormRequest(r, form, false))
		if err != nil {
			return errOAuthRequest
		}
		request.SetID(id)
		request.SetRequestedAudience(fosite.Arguments{s.origin + "/mcp"})
		request.GrantAudience(s.origin + "/mcp")
		for _, scope := range strings.Fields(form.Get("scope")) {
			request.GrantScope(scope)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO oauth_grants(id,account_id,generation,client_id,issuer,resource,scope,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, u.ID, u.Generation, clientID, s.origin, s.origin+"/mcp", form.Get("scope"), now, familyExpiry); err != nil {
			return err
		}
		response, err := provider.NewAuthorizeResponse(ctx, request, &fosite.DefaultSession{Subject: u.ID.String()})
		if err != nil {
			return err
		}
		query.Set("code", response.GetCode())
	}
	if _, err = tx.Exec(ctx, `DELETE FROM oauth_requests WHERE handle_hash=$1`, hashToken(handle)); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	redirect.RawQuery = query.Encode()
	w.Header().Set("X-Morsel-Account-ID", u.ID.String())
	respond(w, 200, map[string]string{"redirect_url": redirect.String()})
	return nil
}

type oauthGrantMetadata struct {
	ID         string     `json:"id"`
	ClientID   string     `json:"client_id"`
	ClientName string     `json:"client_name"`
	Resource   string     `json:"resource"`
	Scope      string     `json:"scope"`
	Created    time.Time  `json:"created_at"`
	Expires    time.Time  `json:"expires_at"`
	Revoked    *time.Time `json:"revoked_at"`
}

func (s *Service) oauthConnectedApps(w http.ResponseWriter, r *http.Request, id string) error {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		return failure(400, "invalid_request", "query parameters are not allowed")
	}
	mutation := r.Method == http.MethodDelete
	if mutation {
		if _, err := uuid.Parse(id); err != nil || len(id) != 36 {
			return failure(400, "invalid_id", "invalid app connection ID")
		}
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	u, _, err := s.requestAuth(r, tx, mutation, mutation)
	if err != nil {
		return err
	}
	if mutation {
		tag, err := tx.Exec(ctx, `UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND account_id=$2`, id, u.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return failure(404, "not_found", "app connection not found")
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		w.Header().Set("X-Morsel-Account-ID", u.ID.String())
		respond(w, 204, nil)
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT g.id,g.client_id,c.name,g.resource,g.scope,g.created_at,g.expires_at,CASE WHEN g.generation<>$2 THEN COALESCE(g.revoked_at,clock_timestamp()) ELSE g.revoked_at END FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.account_id=$1 ORDER BY g.created_at DESC,g.id`, u.ID, u.Generation)
	if err != nil {
		return err
	}
	grants := []oauthGrantMetadata{}
	for rows.Next() {
		var grant oauthGrantMetadata
		if err = rows.Scan(&grant.ID, &grant.ClientID, &grant.ClientName, &grant.Resource, &grant.Scope, &grant.Created, &grant.Expires, &grant.Revoked); err != nil {
			rows.Close()
			return err
		}
		grants = append(grants, grant)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	w.Header().Set("X-Morsel-Account-ID", u.ID.String())
	respond(w, 200, grants)
	return nil
}

// Cleanup deletes at most 2,000 rows per statement. Token tombstones survive
// until family expiry/revocation so reuse detection also works after a restart.
// Grant/client deletion never cascades a large live family in request handling.
func (s *Service) cleanupOAuth(ctx context.Context) {
	now := time.Now().Unix()
	old := s.oauthCleanupAt.Load()
	if now-old < 60 || !s.oauthCleanupAt.CompareAndSwap(old, now) {
		return
	}
	for _, query := range []string{
		`DELETE FROM oauth_requests WHERE handle_hash IN (SELECT handle_hash FROM oauth_requests WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 2000)`,
		`DELETE FROM oauth_tokens WHERE (signature,kind) IN (SELECT t.signature,t.kind FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE g.expires_at<=clock_timestamp() OR g.revoked_at IS NOT NULL OR (t.kind='access' AND t.expires_at<=clock_timestamp()) ORDER BY t.expires_at LIMIT 2000)`,
		`DELETE FROM oauth_grants WHERE id IN (SELECT g.id FROM oauth_grants g WHERE g.expires_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.grant_id=g.id) ORDER BY g.expires_at LIMIT 2000)`,
		`DELETE FROM oauth_clients WHERE id IN (SELECT c.id FROM oauth_clients c WHERE c.expires_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM oauth_grants g WHERE g.client_id=c.id) AND NOT EXISTS(SELECT 1 FROM oauth_requests r WHERE r.client_id=c.id) ORDER BY c.expires_at LIMIT 2000)`,
	} {
		_, _ = s.pool.Exec(ctx, query)
	}
}
