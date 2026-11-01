package auth

import (
	"bytes"
	"context"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
)

func oauthWaitForAccountLocks(t *testing.T, pool *pgxpool.Pool, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_stat_activity a WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%auth_generation,role FROM accounts WHERE id=%' AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='accounts'::regclass AND l.mode='RowShareLock' AND l.granted)`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("OAuth requests did not reach %d account locks", want)
}

func oauthWaitForCredentialWrite(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_locks WHERE relation='oauth_tokens'::regclass AND mode='RowExclusiveLock' AND NOT granted`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("OAuth request did not reach its credential write")
}

func oauthCloneBrowser(b *browser) *browser {
	other := newBrowser(b.s)
	other.csrf = b.csrf
	for name, cookie := range b.cookies {
		other.cookies[name] = cookie
	}
	return other
}

func oauthBlockAccount(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) (pgx.Tx, *account) {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	u, err := lockAccount(t.Context(), tx, id, 1)
	if err != nil {
		t.Fatal(err)
	}
	return tx, u
}

func oauthConcurrentResponses(t *testing.T, results <-chan *httptest.ResponseRecorder, failureStatus int) *httptest.ResponseRecorder {
	t.Helper()
	var winner *httptest.ResponseRecorder
	failures := 0
	for range 2 {
		select {
		case w := <-results:
			if w.Code == 200 && winner == nil {
				winner = w
			} else if w.Code == failureStatus {
				failures++
			} else {
				t.Fatalf("unexpected concurrent result: %d %s", w.Code, w.Body.String())
			}
		case <-time.After(5 * time.Second):
			t.Fatal("OAuth concurrent operation did not finish")
		}
	}
	if winner == nil || failures != 1 {
		t.Fatal("single-use operation did not have exactly one winner")
	}
	return winner
}

func TestOAuthConcurrentConsentApprovalsIssueOneCode(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
	id := oauthHTTPBind(t, b, flow)
	blocker, _ := oauthBlockAccount(t, pool, uuid.MustParse(id))
	body := encode(t, map[string]any{"approve": true, "account_id": id})
	results := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		browser := oauthCloneBrowser(b)
		go func() { results <- browser.request("POST", oauthHTTPRequestPath(flow), body) }()
	}
	oauthWaitForAccountLocks(t, pool, 2)
	if err := blocker.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	winner := oauthConcurrentResponses(t, results, 409)
	oauthHTTPCredential(t, oauthHTTPCallback(t, s, winner, flow).Query().Get("code"), "moc_")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='code' AND active`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_requests`) != 0 {
		t.Fatal("concurrent consent issued more than one grant or code")
	}
}

func TestOAuthConcurrentCodeExchangeReplayRevokesWinner(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	blocker, _ := oauthBlockAccount(t, pool, testdb.AccountID(t, pool))
	form := oauthHTTPCodeForm(s, flow)
	results := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() { results <- oauthHTTPForm(s, "/oauth/token", form) }()
	}
	oauthWaitForAccountLocks(t, pool, 2)
	if err := blocker.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	tokens := oauthHTTPReadTokens(t, oauthConcurrentResponses(t, results, 400), true)
	oauthHTTPAccess(t, s, tokens.Access, uuid.Nil)
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, tokens.Refresh)), 400, "invalid_grant")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE active`) != 0 {
		t.Fatal("concurrent code replay retained a usable winner")
	}
}

func TestOAuthConcurrentRefreshReplayRevokesWinner(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	blocker, _ := oauthBlockAccount(t, pool, testdb.AccountID(t, pool))
	form := oauthHTTPRefreshForm(s, client, tokens.Refresh)
	results := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() { results <- oauthHTTPForm(s, "/oauth/token", form) }()
	}
	oauthWaitForAccountLocks(t, pool, 2)
	if err := blocker.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	rotated := oauthHTTPReadTokens(t, oauthConcurrentResponses(t, results, 400), true)
	oauthHTTPAccess(t, s, tokens.Access, uuid.Nil)
	oauthHTTPAccess(t, s, rotated.Access, uuid.Nil)
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, rotated.Refresh)), 400, "invalid_grant")
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants WHERE revoked_at IS NOT NULL`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE active`) != 0 {
		t.Fatal("concurrent refresh replay retained a usable winner")
	}
}

func TestOAuthPendingOperationsCannotCommitAfterRecovery(t *testing.T) {
	for _, operation := range []string{"approval", "code", "refresh", "account revocation", "native revocation"} {
		t.Run(operation, func(t *testing.T) {
			s, pool := testService(t)
			b := enroll(t, s, pool)
			client := oauthHTTPRegister(t, s, "https://native.example/callback")
			id := testdb.AccountID(t, pool)
			var flow oauthTestFlow
			var tokens oauthTestTokens
			if operation == "approval" {
				flow = oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
				oauthHTTPBind(t, b, flow)
			} else {
				flow = oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
				if operation != "code" {
					tokens = oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
				}
			}
			var grant string
			if operation == "account revocation" {
				if err := pool.QueryRow(t.Context(), `SELECT id FROM oauth_grants`).Scan(&grant); err != nil {
					t.Fatal(err)
				}
			}
			before := testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`)
			blocker, u := oauthBlockAccount(t, pool, id)
			body := encode(t, map[string]any{"approve": true, "account_id": id.String()})
			results := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				switch operation {
				case "approval":
					results <- b.request("POST", oauthHTTPRequestPath(flow), body)
				case "code":
					results <- oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow))
				case "refresh":
					results <- oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, tokens.Refresh))
				case "account revocation":
					results <- b.request("DELETE", "/v1/account/oauth/grants/"+grant, nil)
				case "native revocation":
					results <- oauthHTTPForm(s, "/oauth/revoke", url.Values{"client_id": {client.ID}, "token": {tokens.Refresh}})
				}
			}()
			oauthWaitForAccountLocks(t, pool, 1)
			if err := replaceCredentials(t.Context(), blocker, u, &webauthn.Credential{ID: randomBytes(32)}, "Recovered"); err != nil {
				t.Fatal(err)
			}
			if err := blocker.Commit(t.Context()); err != nil {
				t.Fatal(err)
			}
			w := <-results
			switch operation {
			case "approval", "account revocation":
				oauthHTTPStatus(t, w, 401)
			case "code", "refresh":
				oauthHTTPError(t, w, 400, "invalid_grant")
			case "native revocation":
				oauthHTTPStatus(t, w, 200)
			}
			if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`) != before || testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants g JOIN accounts a ON a.id=g.account_id WHERE g.generation=a.auth_generation AND g.revoked_at IS NULL`) != 0 {
				t.Fatal("pending OAuth operation escaped the recovery generation boundary")
			}
			if tokens.Access != "" {
				oauthHTTPAccess(t, s, tokens.Access, uuid.Nil)
			}
		})
	}
}

func TestOAuthApprovalRechecksSessionAfterAccountLock(t *testing.T) {
	for _, change := range []string{"logout", "CSRF rotation", "verification expiry", "session expiry", "request expiry"} {
		t.Run(change, func(t *testing.T) {
			s, pool := testService(t)
			b := enroll(t, s, pool)
			client := oauthHTTPRegister(t, s, "https://native.example/callback")
			flow := oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
			id := oauthHTTPBind(t, b, flow)
			blocker, _ := oauthBlockAccount(t, pool, uuid.MustParse(id))
			body := encode(t, map[string]any{"approve": true, "account_id": id})
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() { result <- b.request("POST", oauthHTTPRequestPath(flow), body) }()
			oauthWaitForAccountLocks(t, pool, 1)
			query := map[string]string{
				"logout":              `DELETE FROM auth_sessions`,
				"CSRF rotation":       `UPDATE auth_sessions SET csrf_token='changed'`,
				"verification expiry": `UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '13 hours'`,
				"session expiry":      `UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second'`,
				"request expiry":      `UPDATE oauth_requests SET expires_at=clock_timestamp()-interval '1 second'`,
			}[change]
			if _, err := blocker.Exec(t.Context(), query); err != nil {
				t.Fatal(err)
			}
			if err := blocker.Commit(t.Context()); err != nil {
				t.Fatal(err)
			}
			status := 403
			if change == "logout" || change == "session expiry" {
				status = 401
			} else if change == "request expiry" {
				status = 409
			}
			oauthHTTPStatus(t, <-result, status)
			if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants`) != 0 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`) != 0 {
				t.Fatal("approval used session state read before the account lock")
			}
		})
	}
}

func TestOAuthTokenExchangeRechecksExpiryAndRevocationAfterLock(t *testing.T) {
	for _, operation := range []string{"code", "refresh"} {
		for _, change := range []string{"token expiry", "family expiry", "revocation"} {
			t.Run(operation+" "+change, func(t *testing.T) {
				s, pool := testService(t)
				b := enroll(t, s, pool)
				client := oauthHTTPRegister(t, s, "https://native.example/callback")
				flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
				form := oauthHTTPCodeForm(s, flow)
				if operation == "refresh" {
					tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", form), true)
					form = oauthHTTPRefreshForm(s, client, tokens.Refresh)
				}
				before := testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`)
				blocker, _ := oauthBlockAccount(t, pool, testdb.AccountID(t, pool))
				result := make(chan *httptest.ResponseRecorder, 1)
				go func() { result <- oauthHTTPForm(s, "/oauth/token", form) }()
				oauthWaitForAccountLocks(t, pool, 1)
				query := map[string]string{
					"token expiry":  `UPDATE oauth_tokens SET expires_at=clock_timestamp()-interval '1 second'`,
					"family expiry": `UPDATE oauth_grants SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 second'`,
					"revocation":    `UPDATE oauth_grants SET revoked_at=clock_timestamp()`,
				}[change]
				if _, err := blocker.Exec(t.Context(), query); err != nil {
					t.Fatal(err)
				}
				if err := blocker.Commit(t.Context()); err != nil {
					t.Fatal(err)
				}
				oauthHTTPError(t, <-result, 400, "invalid_grant")
				if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`) != before {
					t.Fatal("expired or revoked exchange created token records")
				}
			})
		}
	}
}

func TestOAuthCanceledExchangeDoesNotConsumeCode(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	blocker, _ := oauthBlockAccount(t, pool, testdb.AccountID(t, pool))
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(oauthHTTPCodeForm(s, flow).Encode())).WithContext(ctx)
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); s.OAuthHandler().ServeHTTP(w, r); result <- w }()
	oauthWaitForAccountLocks(t, pool, 1)
	cancel()
	select {
	case w := <-result:
		oauthHTTPError(t, w, 503, "temporarily_unavailable")
	case <-time.After(3 * time.Second):
		t.Fatal("canceled OAuth request retained a database wait")
	}
	if err := blocker.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='code' AND active`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='pkce'`) != 1 {
		t.Fatal("canceled exchange consumed code or PKCE state")
	}
	oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
}

func TestOAuthSlowProtocolBodyDoesNotHoldAccountLock(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	slow := &blockedReader{entered: make(chan struct{}), release: make(chan struct{}), body: bytes.NewBufferString(oauthHTTPCodeForm(s, flow).Encode())}
	defer func() {
		select {
		case <-slow.release:
		default:
			close(slow.release)
		}
	}()
	r := httptest.NewRequest("POST", "/oauth/token", slow)
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); s.OAuthHandler().ServeHTTP(w, r); result <- w }()
	select {
	case <-slow.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("OAuth exchange did not read protocol input")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if _, err := IssueGrant(ctx, pool, "recover", testdb.AccountID(t, pool)); err != nil {
		t.Fatalf("slow protocol body blocked recovery: %v", err)
	}
	close(slow.release)
	oauthHTTPReadTokens(t, <-result, true)
}

func TestOAuthExchangeHoldsAccountLockThroughCredentialWrites(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	id := testdb.AccountID(t, pool)
	blocker, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err = blocker.Exec(t.Context(), `LOCK TABLE oauth_tokens IN SHARE MODE`); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)) }()
	// PKCE consumption and code invalidation write this table before insertion.
	// Account ownership must already be locked when the first write waits.
	oauthWaitForCredentialWrite(t, pool)
	recovered := make(chan error, 1)
	go func() {
		tx, err := pool.Begin(t.Context())
		if err != nil {
			recovered <- err
			return
		}
		defer tx.Rollback(context.Background())
		u, err := lockAccount(t.Context(), tx, id, 1)
		if err == nil {
			err = replaceCredentials(t.Context(), tx, u, &webauthn.Credential{ID: randomBytes(32)}, "Recovered")
		}
		if err == nil {
			err = tx.Commit(t.Context())
		}
		recovered <- err
	}()
	oauthWaitForAccountLocks(t, pool, 1)
	if err = blocker.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	tokens := oauthHTTPReadTokens(t, <-result, true)
	if err = <-recovered; err != nil {
		t.Fatal(err)
	}
	oauthHTTPAccess(t, s, tokens.Access, uuid.Nil)
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, tokens.Refresh)), 400, "invalid_grant")
}

func oauthCleanupNow(s *Service, ctx context.Context) {
	s.oauthCleanupAt.Store(0)
	s.cleanupOAuth(ctx)
}

func TestOAuthHTTPCapacityCleanupAndAdmission(t *testing.T) {
	t.Run("clients", func(t *testing.T) {
		s, pool := testService(t)
		if _, err := pool.Exec(t.Context(), `INSERT INTO oauth_clients(id,name,redirect_uris,expires_at) SELECT md5('capacity-client-'||n)::uuid,'Native','["http://127.0.0.1:1234/callback"]',clock_timestamp()+interval '90 days' FROM generate_series(1,10000) n`); err != nil {
			t.Fatal(err)
		}
		body := string(encode(t, oauthHTTPRegistration("http://127.0.0.1:1234/callback")))
		oauthHTTPError(t, oauthHTTPRequest(s, "POST", "/oauth/register", "application/json", body), 429, "temporarily_unavailable")
		if _, err := pool.Exec(t.Context(), `UPDATE oauth_clients SET expires_at=clock_timestamp()-interval '1 second' WHERE id=md5('capacity-client-1')::uuid`); err != nil {
			t.Fatal(err)
		}
		oauthCleanupNow(s, t.Context())
		oauthHTTPRegister(t, s, "http://127.0.0.1:1234/callback")
		if testdb.Count(t, pool, `SELECT count(*) FROM oauth_clients`) != 10000 {
			t.Fatal("client admission exceeded the persistent bound")
		}
	})
	t.Run("requests", func(t *testing.T) {
		s, pool := testService(t)
		client := oauthHTTPRegister(t, s, "https://native.example/callback")
		if _, err := pool.Exec(t.Context(), `INSERT INTO oauth_requests(handle_hash,client_id,form,expires_at) SELECT sha256(('request-'||n)::bytea),$1,'{}',clock_timestamp()+interval '10 minutes' FROM generate_series(1,10000) n`, client.ID); err != nil {
			t.Fatal(err)
		}
		flow := oauthTestFlow{Client: client, Redirect: client.RedirectURIs[0], Verifier: randomToken(), State: "state-123456"}
		oauthHTTPError(t, oauthHTTPRequest(s, "GET", "/oauth/authorize?"+oauthHTTPAuthorizeForm(s, flow, oauthTestScope).Encode(), "", ""), 429, "temporarily_unavailable")
		if _, err := pool.Exec(t.Context(), `UPDATE oauth_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE handle_hash=sha256('request-1'::bytea)`); err != nil {
			t.Fatal(err)
		}
		oauthCleanupNow(s, t.Context())
		oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
		if testdb.Count(t, pool, `SELECT count(*) FROM oauth_requests`) != 10000 {
			t.Fatal("authorization request admission exceeded the persistent bound")
		}
	})
	for _, bound := range []string{"per account grants", "all grants"} {
		t.Run(bound, func(t *testing.T) {
			s, pool := testService(t)
			b := enroll(t, s, pool)
			client := oauthHTTPRegister(t, s, "https://native.example/callback")
			flow := oauthHTTPBegin(t, s, client, client.RedirectURIs[0], oauthTestScope)
			owner := oauthHTTPBind(t, b, flow)
			count := 100
			account := "$1::uuid"
			if bound == "all grants" {
				count = 10000
				account = "md5('capacity-owner-'||((n-1)/100+1))::uuid"
				if _, err := pool.Exec(t.Context(), `INSERT INTO accounts(id) SELECT md5('capacity-owner-'||n)::uuid FROM generate_series(1,100) n`); err != nil {
					t.Fatal(err)
				}
			}
			query := fmt.Sprintf(`INSERT INTO oauth_grants(id,account_id,generation,client_id,issuer,resource,scope,expires_at,revoked_at) SELECT md5('capacity-grant-'||n)::uuid,%s,1,$2,$3,$3||'/mcp','mcp:shares offline_access',clock_timestamp()+interval '30 days',CASE WHEN n%%2=0 THEN clock_timestamp() END FROM generate_series(1,%d) n WHERE $1::uuid IS NOT NULL`, account, count)
			if _, err := pool.Exec(t.Context(), query, owner, client.ID, s.origin); err != nil {
				t.Fatal(err)
			}
			oauthHTTPPrivateError(t, oauthHTTPDecision(t, b, flow, owner, true), 429, "rate_limited")
			if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants`) != int64(count) || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`) != 0 {
				t.Fatal("grant limit failed closed or discarded the pending request")
			}
			if _, err := pool.Exec(t.Context(), `UPDATE oauth_grants SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=md5('capacity-grant-1')::uuid`); err != nil {
				t.Fatal(err)
			}
			oauthCleanupNow(s, t.Context())
			w := oauthHTTPDecision(t, b, flow, owner, true)
			oauthHTTPCredential(t, oauthHTTPCallback(t, s, w, flow).Query().Get("code"), "moc_")
			if testdb.Count(t, pool, `SELECT count(*) FROM oauth_grants`) != int64(count) {
				t.Fatal("grant admission exceeded its retained-record bound")
			}
		})
	}
	t.Run("family token rollback", func(t *testing.T) {
		s, pool := testService(t)
		b := enroll(t, s, pool)
		client := oauthHTTPRegister(t, s, "https://native.example/callback")
		flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
		if _, err := pool.Exec(t.Context(), `INSERT INTO oauth_tokens(signature,kind,grant_id,request_data,expires_at) SELECT encode(sha256(('capacity-token-'||n)::bytea),'hex'),'access',g.id,'{}',clock_timestamp()+interval '10 minutes' FROM oauth_grants g CROSS JOIN generate_series(1,9998) n`); err != nil {
			t.Fatal(err)
		}
		oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), 503, "temporarily_unavailable")
		if testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens`) != 10000 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='code' AND active`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='pkce'`) != 1 {
			t.Fatal("token capacity failure did not roll back partial code exchange")
		}
		if _, err := pool.Exec(t.Context(), `DELETE FROM oauth_tokens WHERE kind='access'`); err != nil {
			t.Fatal(err)
		}
		oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	})
}

func TestOAuthCleanupIsBoundedAndRetainsActiveFamilyReplayEvidence(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	client := oauthHTTPRegister(t, s, "https://native.example/callback")
	flow := oauthHTTPApproved(t, b, client, client.RedirectURIs[0], oauthTestScope)
	tokens := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPCodeForm(s, flow)), true)
	rotated := oauthHTTPReadTokens(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, tokens.Refresh)), true)
	if _, err := pool.Exec(t.Context(), `UPDATE oauth_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE NOT active OR kind='code'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO oauth_requests(handle_hash,client_id,form,expires_at) SELECT sha256(('expired-request-'||n)::bytea),$1,'{}',clock_timestamp()-interval '1 second' FROM generate_series(1,4500) n`, client.ID); err != nil {
		t.Fatal(err)
	}
	oauthCleanupNow(s, t.Context())
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_requests`) != 2500 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='code' AND NOT active`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM oauth_tokens WHERE kind='refresh' AND NOT active`) != 1 {
		t.Fatal("cleanup exceeded its batch limit or removed live-family replay evidence")
	}
	oauthCleanupNow(s, t.Context())
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_requests`) != 500 {
		t.Fatal("cleanup did not continue in bounded batches")
	}
	oauthCleanupNow(s, t.Context())
	if testdb.Count(t, pool, `SELECT count(*) FROM oauth_requests`) != 0 {
		t.Fatal("cleanup did not remove expired request records")
	}
	oauthHTTPAccess(t, s, rotated.Access, testdb.AccountID(t, pool))
	// An inactive, expired refresh tombstone still identifies a live family.
	oauthHTTPError(t, oauthHTTPForm(s, "/oauth/token", oauthHTTPRefreshForm(s, client, tokens.Refresh)), 400, "invalid_grant")
	oauthHTTPAccess(t, s, rotated.Access, uuid.Nil)
	if _, err := pool.Exec(t.Context(), `UPDATE oauth_grants SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 second'; UPDATE oauth_clients SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	oauthCleanupNow(s, t.Context())
	for _, table := range []string{"oauth_tokens", "oauth_grants", "oauth_clients"} {
		if testdb.Count(t, pool, `SELECT count(*) FROM `+table) != 0 {
			t.Fatalf("cleanup retained expired %s", table)
		}
	}
}
