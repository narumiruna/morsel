package auth

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type account struct {
	ID          uuid.UUID
	Generation  int64
	Credentials []webauthn.Credential
}

func (u *account) WebAuthnID() []byte                         { return u.ID[:] }
func (u *account) WebAuthnName() string                       { return "owner" }
func (u *account) WebAuthnDisplayName() string                { return "Morsel owner" }
func (u *account) WebAuthnCredentials() []webauthn.Credential { return u.Credentials }

func owner(ctx context.Context, tx pgx.Tx) (*account, error) {
	u := &account{}
	err := tx.QueryRow(ctx, `SELECT id,auth_generation FROM accounts ORDER BY created_at,id LIMIT 1 FOR UPDATE`).Scan(&u.ID, &u.Generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, failure(409, "setup_required", "owner setup required")
	}
	return u, err
}
func lockAccount(ctx context.Context, tx pgx.Tx, id uuid.UUID, generation int64) (*account, error) {
	u := &account{ID: id}
	err := tx.QueryRow(ctx, `SELECT auth_generation FROM accounts WHERE id=$1 FOR UPDATE`, id).Scan(&u.Generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errGeneration
	}
	if err != nil {
		return nil, err
	}
	if u.Generation != generation {
		return nil, errGeneration
	}
	return u, nil
}
func loadCredentials(ctx context.Context, tx pgx.Tx, u *account) error {
	rows, err := tx.Query(ctx, `SELECT credential FROM passkey_credentials WHERE account_id=$1 ORDER BY id`, u.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	u.Credentials = nil
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			return err
		}
		var c webauthn.Credential
		if err := json.Unmarshal(b, &c); err != nil {
			return err
		}
		u.Credentials = append(u.Credentials, c)
	}
	return rows.Err()
}
func saveCredential(ctx context.Context, tx pgx.Tx, u *account, c *webauthn.Credential, name string) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO passkey_credentials(id,account_id,name,credential) VALUES($1,$2,$3,$4)`, credentialID(c.ID), u.ID, name, b)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return failure(409, "credential_exists", "passkey is already registered")
	}
	return err
}

type session struct {
	Hash       []byte
	AccountID  uuid.UUID
	Generation int64
	CSRF       string
}

// Lock order is always account, then authorization records. Entry checks alone are
// not authorization: each mutation calls this again in its completion transaction.
func (s *Service) authorize(ctx context.Context, tx pgx.Tx, token, csrf string, mutation, fresh bool) (*account, *session, error) {
	if token == "" {
		return nil, nil, errUnauthorized
	}
	ss := &session{Hash: hashToken(token)}
	err := tx.QueryRow(ctx, `SELECT account_id,generation FROM auth_sessions WHERE token_hash=$1`, ss.Hash).Scan(&ss.AccountID, &ss.Generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, errUnauthorized
	}
	if err != nil {
		return nil, nil, err
	}
	u, err := lockAccount(ctx, tx, ss.AccountID, ss.Generation)
	if err != nil {
		return nil, nil, err
	}
	var verified bool
	err = tx.QueryRow(ctx, `SELECT csrf_token, verified_at > clock_timestamp()-make_interval(secs => $4) FROM auth_sessions WHERE token_hash=$1 AND account_id=$2 AND generation=$3 AND expires_at>clock_timestamp() FOR UPDATE`, ss.Hash, u.ID, u.Generation, verifyLifetime.Seconds()).Scan(&ss.CSRF, &verified)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, errUnauthorized
	}
	if err != nil {
		return nil, nil, err
	}
	if mutation && subtle.ConstantTimeCompare([]byte(csrf), []byte(ss.CSRF)) != 1 {
		return nil, nil, failure(403, "invalid_csrf", "valid CSRF token required")
	}
	if fresh && !verified {
		return nil, nil, errFresh
	}
	return u, ss, nil
}
func newSession(ctx context.Context, tx pgx.Tx, u *account) (string, error) {
	token := randomToken()
	_, err := tx.Exec(ctx, `INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+make_interval(secs => $5))`, hashToken(token), u.ID, u.Generation, randomToken(), sessionLifetime.Seconds())
	return token, err
}

// IssueGrant is the operator-only entry point. Raw tokens are returned once and
// only their hashes are persisted. Issuing a replacement cancels earlier grants.
func IssueGrant(ctx context.Context, pool *pgxpool.Pool, kind string) (string, error) {
	if kind != "setup" && kind != "recover" {
		return "", errors.New("kind must be setup or recover")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, setupLock); err != nil {
		return "", err
	}
	var id *uuid.UUID
	var generation *int64
	if kind == "setup" {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM accounts)`).Scan(&exists); err != nil {
			return "", err
		}
		if exists {
			return "", errors.New("owner already exists")
		}
	} else {
		u, e := owner(ctx, tx)
		if e != nil {
			return "", e
		}
		id = &u.ID
		generation = &u.Generation
	}
	if _, err = tx.Exec(ctx, `DELETE FROM auth_grants WHERE kind=$1`, kind); err != nil {
		return "", err
	}
	token := randomToken()
	_, err = tx.Exec(ctx, `INSERT INTO auth_grants(token_hash,kind,account_id,generation,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+make_interval(secs => $5))`, hashToken(token), kind, id, generation, grantLifetime.Seconds())
	if err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return token, nil
}
func validGrant(ctx context.Context, tx pgx.Tx, hash []byte, kind string, u *account, consume bool) error {
	var valid bool
	var id any
	var gen any
	if kind == "recover" {
		id = u.ID
		gen = u.Generation
	}
	query := `SELECT EXISTS(SELECT 1 FROM auth_grants WHERE token_hash=$1 AND kind=$2 AND account_id IS NOT DISTINCT FROM $3::uuid AND generation IS NOT DISTINCT FROM $4::bigint AND expires_at>clock_timestamp())`
	if err := tx.QueryRow(ctx, query, hash, kind, id, gen).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return errGrant
	}
	if consume {
		tag, err := tx.Exec(ctx, `DELETE FROM auth_grants WHERE token_hash=$1 AND expires_at>clock_timestamp()`, hash)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errGrant
		}
	}
	return nil
}

// Cleanup performs a fixed amount of work, at most once per minute per service.
// No request starts a goroutine or an unbounded table deletion.
func (s *Service) cleanup(ctx context.Context) {
	now := time.Now().Unix()
	old := s.cleanupAt.Load()
	if now-old < 60 || !s.cleanupAt.CompareAndSwap(old, now) {
		return
	}
	for _, table := range []string{"auth_flows", "auth_sessions", "auth_grants"} {
		_, _ = s.pool.Exec(ctx, `DELETE FROM `+table+` WHERE ctid IN (SELECT ctid FROM `+table+` WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 2000)`)
	}
}
