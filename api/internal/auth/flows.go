package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type flow struct {
	Kind                   string
	AccountID              uuid.UUID
	Generation             int64
	SessionHash, GrantHash []byte
	Name                   string
	Data                   webauthn.SessionData
}

func (s *Service) begin(w http.ResponseWriter, r *http.Request, kind string) error {
	var body struct {
		Token string `json:"token"`
		Name  string `json:"name"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if len(body.Token) > 256 {
		return errGrant
	}
	if body.Name == "" {
		body.Name = "Passkey"
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
	f := flow{Kind: kind, Name: name}
	var u *account
	switch kind {
	case "setup":
		if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, setupLock); err != nil {
			return err
		}
		var exists bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM accounts)`).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return failure(409, "setup_closed", "owner already exists")
		}
		f.GrantHash = hashToken(body.Token)
		if err = validGrant(r.Context(), tx, f.GrantHash, kind, nil, false); err != nil {
			return err
		}
		u = &account{ID: uuid.New(), Generation: 1}
	case "recover":
		u, err = owner(r.Context(), tx)
		if err != nil {
			return err
		}
		f.GrantHash = hashToken(body.Token)
		if err = validGrant(r.Context(), tx, f.GrantHash, kind, u, false); err != nil {
			return err
		}
	case "login":
		u, err = owner(r.Context(), tx)
		if err != nil {
			return err
		}
	case "verify", "passkey":
		var ss *session
		u, ss, err = s.requestAuth(r, tx, true, kind == "passkey")
		if err != nil {
			return err
		}
		f.SessionHash = ss.Hash
	}
	if err = loadCredentials(r.Context(), tx, u); err != nil {
		return err
	}
	f.AccountID = u.ID
	f.Generation = u.Generation
	var options any
	var data *webauthn.SessionData
	if kind == "login" || kind == "verify" {
		options, data, err = s.web.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	} else {
		options, data, err = s.web.BeginRegistration(u, webauthn.WithExclusions(webauthn.Credentials(u.Credentials).CredentialDescriptors()))
	}
	if err != nil {
		return err
	}
	f.Data = *data
	encoded, err := json.Marshal(f.Data)
	if err != nil {
		return err
	}
	// Replacing the browser's flow cancels its earlier ceremony, without exposing
	// a flow identifier to JavaScript or allowing one operation to finish another.
	if previous := cookieValue(r, flowCookie); previous != "" {
		if _, err = tx.Exec(r.Context(), `DELETE FROM auth_flows WHERE token_hash=$1`, hashToken(previous)); err != nil {
			return err
		}
	}
	token := randomToken()
	_, err = tx.Exec(r.Context(), `INSERT INTO auth_flows(token_hash,kind,account_id,generation,session_hash,grant_hash,name,session_data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+make_interval(secs => $9))`, hashToken(token), f.Kind, f.AccountID, f.Generation, f.SessionHash, f.GrantHash, f.Name, encoded, flowLifetime.Seconds())
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	s.cookie(w, flowCookie, token, false)
	respond(w, 200, options)
	return nil
}

// consumeFlow commits independently of credential validation. A failed ceremony
// cannot retry the same challenge, and simultaneous finishes cannot both win.
func (s *Service) consumeFlow(ctx context.Context, token, kind string) (*flow, error) {
	if token == "" {
		return nil, errFlow
	}
	f := &flow{}
	var data []byte
	err := s.pool.QueryRow(ctx, `DELETE FROM auth_flows WHERE token_hash=$1 AND kind=$2 AND expires_at>clock_timestamp() RETURNING kind,account_id,generation,session_hash,grant_hash,name,session_data`, hashToken(token), kind).Scan(&f.Kind, &f.AccountID, &f.Generation, &f.SessionHash, &f.GrantHash, &f.Name, &data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errFlow
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(data, &f.Data); err != nil {
		return nil, err
	}
	return f, nil
}
func (s *Service) finish(w http.ResponseWriter, r *http.Request, kind string) error {
	f, err := s.consumeFlow(r.Context(), cookieValue(r, flowCookie), kind)
	if err != nil {
		return err
	}
	s.cookie(w, flowCookie, "", true)
	// Read and parse all untrusted input before taking the account lock or a
	// transaction connection. Slow clients must not block owner recovery.
	body, err := io.ReadAll(r.Body)
	if err != nil || !json.Valid(body) {
		return failure(400, "invalid_credential", "valid credential JSON required")
	}
	var assertion *protocol.ParsedCredentialAssertionData
	var creation *protocol.ParsedCredentialCreationData
	if kind == "login" || kind == "verify" {
		assertion, err = protocol.ParseCredentialRequestResponseBytes(body)
	} else {
		creation, err = protocol.ParseCredentialCreationResponseBytes(body)
	}
	if err != nil {
		return failure(400, "invalid_credential", "passkey response is invalid")
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var u *account
	if kind == "setup" {
		if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, setupLock); err != nil {
			return err
		}
		var exists bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM accounts)`).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return failure(409, "setup_closed", "owner already exists")
		}
		if err = validGrant(r.Context(), tx, f.GrantHash, kind, nil, true); err != nil {
			return err
		}
		u = &account{ID: f.AccountID, Generation: f.Generation}
	} else {
		u, err = lockAccount(r.Context(), tx, f.AccountID, f.Generation)
		if err != nil {
			return err
		}
	}
	if kind == "passkey" || kind == "verify" {
		authorized, ss, e := s.requestAuth(r, tx, true, kind == "passkey")
		if e != nil {
			return e
		}
		if authorized.ID != u.ID || !bytes.Equal(ss.Hash, f.SessionHash) {
			return errUnauthorized
		}
	}
	if kind == "recover" {
		if err = validGrant(r.Context(), tx, f.GrantHash, kind, u, true); err != nil {
			return err
		}
	}
	if err = loadCredentials(r.Context(), tx, u); err != nil {
		return err
	}
	var credential *webauthn.Credential
	if kind == "login" || kind == "verify" {
		_, credential, err = s.web.ValidatePasskeyLogin(func(rawID, userHandle []byte) (webauthn.User, error) {
			if !bytes.Equal(userHandle, u.WebAuthnID()) {
				return nil, errUnauthorized
			}
			return u, nil
		}, f.Data, assertion)
	} else {
		credential, err = s.web.CreateCredential(u, f.Data, creation)
	}
	if err != nil {
		return failure(400, "invalid_credential", "passkey verification failed")
	}
	var sessionToken string
	switch kind {
	case "setup":
		if _, err = tx.Exec(r.Context(), `INSERT INTO accounts(id,auth_generation) VALUES($1,$2)`, u.ID, u.Generation); err != nil {
			return err
		}
		if err = saveCredential(r.Context(), tx, u, credential, f.Name); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `DELETE FROM auth_grants WHERE kind='setup'`); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `DELETE FROM auth_flows WHERE kind='setup'`); err != nil {
			return err
		}
		sessionToken, err = newSession(r.Context(), tx, u)
	case "recover":
		if err = replaceCredentials(r.Context(), tx, u, credential, f.Name); err != nil {
			return err
		}
		sessionToken, err = newSession(r.Context(), tx, u)
	case "passkey":
		err = saveCredential(r.Context(), tx, u, credential, f.Name)
	case "login", "verify":
		var b []byte
		b, err = json.Marshal(credential)
		if err != nil {
			return err
		}
		// Persist the library's backup-aware counter and flags, including clone
		// warnings. Do not impose a strict monotonic-counter policy on synced keys.
		_, err = tx.Exec(r.Context(), `UPDATE passkey_credentials SET credential=$1 WHERE account_id=$2 AND id=$3`, b, u.ID, credentialID(credential.ID))
		if err != nil {
			return err
		}
		if kind == "login" {
			sessionToken, err = newSession(r.Context(), tx, u)
		} else {
			_, err = tx.Exec(r.Context(), `UPDATE auth_sessions SET verified_at=clock_timestamp() WHERE token_hash=$1`, f.SessionHash)
		}
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	if sessionToken != "" {
		s.cookie(w, sessionCookie, sessionToken, false)
	}
	respond(w, 200, map[string]bool{"authenticated": true})
	return nil
}

// Caller holds the account lock. All old authorizations are invalidated in the
// same transaction as replacement. API keys deliberately remain active.
func replaceCredentials(ctx context.Context, tx pgx.Tx, u *account, c *webauthn.Credential, name string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM passkey_credentials WHERE account_id=$1`, u.ID); err != nil {
		return err
	}
	if err := saveCredential(ctx, tx, u, c, name); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `UPDATE accounts SET auth_generation=auth_generation+1 WHERE id=$1 RETURNING auth_generation`, u.ID).Scan(&u.Generation); err != nil {
		return err
	}
	for _, table := range []string{"auth_sessions", "auth_flows", "auth_grants"} {
		if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE account_id=$1`, u.ID); err != nil {
			return err
		}
	}
	return nil
}
