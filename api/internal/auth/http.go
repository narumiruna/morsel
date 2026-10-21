package auth

import (
	"context"
	"encoding/base64"
	"mime"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func credentialID(id []byte) string { return base64.RawURLEncoding.EncodeToString(id) }

type rateBucket struct {
	start time.Time
	count int
}
type rateLimiter struct {
	mu      sync.Mutex
	clients map[string]rateBucket
	global  rateBucket
}

func (l *rateLimiter) allow(remote, kind string, now time.Time) bool {
	ip, _, err := net.SplitHostPort(remote)
	if err != nil {
		ip = remote
	}
	if len(ip) > 128 {
		ip = "invalid"
	}
	ip += "|" + kind
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.global.start) >= time.Minute {
		l.global = rateBucket{start: now}
		for key, b := range l.clients {
			if now.Sub(b.start) >= time.Minute {
				delete(l.clients, key)
			}
		}
	}
	if l.global.count >= 1000 {
		return false
	}
	l.global.count++
	if l.clients == nil {
		l.clients = make(map[string]rateBucket)
	}
	b, exists := l.clients[ip]
	if !exists && len(l.clients) >= 4096 {
		return false
	}
	if now.Sub(b.start) >= time.Minute {
		b = rateBucket{start: now}
	}
	if b.count >= 60 {
		return false
	}
	b.count++
	l.clients[ip] = b
	return true
}
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != "GET" {
		if len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != s.origin {
			respondError(w, failure(403, "invalid_origin", "exact application Origin required"))
			return
		}
		if r.Method == "POST" {
			media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || media != "application/json" {
				respondError(w, failure(400, "invalid_content_type", "application/json required"))
				return
			}
		}
	}
	// Account reads and authenticated management requests do not spend the
	// ceremony budget. Only passkey/setup/recovery attempts use this limiter.
	if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/auth/") && r.URL.Path != "/v1/auth/logout" {
		kind := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/auth/"), "/")[0]
		if !validKind(kind) {
			kind = "other"
		}
		if !s.limiter.allow(r.RemoteAddr, kind, time.Now()) {
			w.Header().Set("Retry-After", "60")
			respondError(w, failure(429, "rate_limited", "too many authentication requests"))
			return
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	s.cleanup(ctx)
	var err error
	path := r.URL.Path
	switch {
	case path == "/v1/account" && r.Method == "GET":
		err = s.accountState(w, r)
	case path == "/v1/auth/logout" && r.Method == "POST":
		err = s.logout(w, r)
	case strings.HasPrefix(path, "/v1/auth/") && r.Method == "POST":
		parts := strings.Split(strings.TrimPrefix(path, "/v1/auth/"), "/")
		if len(parts) != 2 || !validKind(parts[0]) {
			err = failure(404, "not_found", "route not found")
		} else if parts[1] == "begin" {
			err = s.begin(w, r, parts[0])
		} else if parts[1] == "finish" {
			err = s.finish(w, r, parts[0])
		} else {
			err = failure(404, "not_found", "route not found")
		}
	case path == "/v1/api-keys" && r.Method == "GET":
		err = s.listKeys(w, r)
	case path == "/v1/api-keys" && r.Method == "POST":
		err = s.createKey(w, r)
	case strings.HasPrefix(path, "/v1/api-keys/") && r.Method == "DELETE":
		err = s.revokeKey(w, r, strings.TrimPrefix(path, "/v1/api-keys/"))
	case path == "/v1/passkeys" && r.Method == "GET":
		err = s.listPasskeys(w, r)
	case strings.HasPrefix(path, "/v1/passkeys/") && r.Method == "DELETE":
		err = s.deletePasskey(w, r, strings.TrimPrefix(path, "/v1/passkeys/"))
	default:
		err = failure(404, "not_found", "route not found")
	}
	if err != nil {
		respondError(w, err)
	}
}
func validKind(k string) bool {
	switch k {
	case "setup", "login", "recover", "verify", "passkey":
		return true
	}
	return false
}
func (s *Service) requestAuth(r *http.Request, tx pgx.Tx, mutation, fresh bool) (*account, *session, error) {
	return s.authorize(r.Context(), tx, cookieValue(r, sessionCookie), r.Header.Get("X-CSRF-Token"), mutation, fresh)
}
func (s *Service) accountState(w http.ResponseWriter, r *http.Request) error {
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var exists bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM accounts)`).Scan(&exists); err != nil {
		return err
	}
	state := map[string]any{"setup_required": !exists, "authenticated": false}
	if cookieValue(r, sessionCookie) != "" {
		_, ss, e := s.requestAuth(r, tx, false, false)
		if e == nil {
			state["authenticated"] = true
			state["csrf_token"] = ss.CSRF
		} else if _, ok := e.(*apiError); !ok {
			return e
		} else {
			s.cookie(w, sessionCookie, "", true)
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, 200, state)
	return nil
}
func (s *Service) logout(w http.ResponseWriter, r *http.Request) error {
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	_, ss, err := s.requestAuth(r, tx, true, false)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM auth_sessions WHERE token_hash=$1`, ss.Hash); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	s.cookie(w, sessionCookie, "", true)
	respond(w, 204, nil)
	return nil
}
func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 200 || !utf8.ValidString(name) || strings.ContainsAny(name, "\x00\r\n") {
		return "", failure(400, "invalid_name", "name must contain 1 to 200 bytes")
	}
	return name, nil
}

type keyMetadata struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Prefix    string     `json:"prefix"`
	CreatedAt time.Time  `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at"`
}

func (s *Service) listKeys(w http.ResponseWriter, r *http.Request) error {
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	u, _, err := s.requestAuth(r, tx, false, false)
	if err != nil {
		return err
	}
	rows, err := tx.Query(r.Context(), `SELECT id,name,prefix,created_at,revoked_at FROM api_keys WHERE account_id=$1 ORDER BY created_at,id`, u.ID)
	if err != nil {
		return err
	}
	keys := []keyMetadata{}
	for rows.Next() {
		var k keyMetadata
		if err = rows.Scan(&k.ID, &k.Name, &k.Prefix, &k.CreatedAt, &k.RevokedAt); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, k)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, 200, keys)
	return nil
}
func (s *Service) createKey(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	name, err := cleanName(body.Name)
	if err != nil {
		return err
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
	raw := "msk_" + randomToken()
	k := keyMetadata{ID: uuid.NewString(), Name: name, Prefix: raw[:12]}
	err = tx.QueryRow(r.Context(), `INSERT INTO api_keys(id,account_id,name,prefix,token_hash) VALUES($1,$2,$3,$4,$5) RETURNING created_at`, k.ID, u.ID, k.Name, k.Prefix, hashToken(raw)).Scan(&k.CreatedAt)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, 201, struct {
		keyMetadata
		Key string `json:"key"`
	}{k, raw})
	return nil
}
func (s *Service) revokeKey(w http.ResponseWriter, r *http.Request, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return failure(400, "invalid_id", "invalid key ID")
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
	if _, err = tx.Exec(r.Context(), `UPDATE api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND account_id=$2`, id, u.ID); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, 204, nil)
	return nil
}

type passkeyMetadata struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Service) listPasskeys(w http.ResponseWriter, r *http.Request) error {
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	u, _, err := s.requestAuth(r, tx, false, false)
	if err != nil {
		return err
	}
	rows, err := tx.Query(r.Context(), `SELECT id,name,created_at FROM passkey_credentials WHERE account_id=$1 ORDER BY created_at,id`, u.ID)
	if err != nil {
		return err
	}
	keys := []passkeyMetadata{}
	for rows.Next() {
		var k passkeyMetadata
		if err = rows.Scan(&k.ID, &k.Name, &k.CreatedAt); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, k)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, 200, keys)
	return nil
}
func (s *Service) deletePasskey(w http.ResponseWriter, r *http.Request, id string) error {
	if b, err := base64.RawURLEncoding.DecodeString(id); err != nil || len(b) == 0 || len(b) > 1024 {
		return failure(400, "invalid_id", "invalid passkey ID")
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
	var count int
	var exists bool
	if err = tx.QueryRow(r.Context(), `SELECT count(*),COALESCE(bool_or(id=$2),false) FROM passkey_credentials WHERE account_id=$1`, u.ID, id).Scan(&count, &exists); err != nil {
		return err
	}
	if exists && count <= 1 {
		return failure(409, "last_passkey", "cannot delete the last passkey")
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM passkey_credentials WHERE account_id=$1 AND id=$2`, u.ID, id); err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	respond(w, 204, nil)
	return nil
}
