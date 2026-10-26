package auth

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
)

const invitationsPath = "/v1/account/invitations"

type invitationResponse struct {
	InvitationURL string    `json:"invitation_url"`
	ExpiresAt     time.Time `json:"expires_at"`
}

func readInvitation(t *testing.T, w *httptest.ResponseRecorder) invitationResponse {
	t.Helper()
	requireStatus(t, w, 201)
	var result invitationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func invitationToken(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimPrefix(u.Fragment, "token=")
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(decoded) != 32 || len(token) != 43 || u.Path != "/invite" || u.RawQuery != "" || u.Fragment != "token="+token {
		t.Fatalf("invalid invitation URL %q", raw)
	}
	return token
}

func TestBrowserInvitationCreationAndRedemption(t *testing.T) {
	s, pool := testService(t)
	admin := enroll(t, s, pool)
	id := admin.state(t)["account_id"].(string)
	// The URL must come from configuration, not Host, forwarded headers, or a
	// request path. Copying it must not change shared public capability settings.
	configured, _ := url.Parse("https://configured.example/base")
	s.publicURL = configured
	r := httptest.NewRequest("POST", "https://attacker.example"+invitationsPath, strings.NewReader(`{}`))
	r.Header.Set("Origin", s.origin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-CSRF-Token", admin.csrf)
	r.Header.Set("X-Forwarded-Host", "forwarded.example")
	for _, c := range admin.cookies {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	result := readInvitation(t, w)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Morsel-Account-ID") != id || !strings.HasPrefix(result.InvitationURL, "https://configured.example/invite#token=") || configured.String() != "https://configured.example/base" {
		t.Fatalf("unsafe response: %v %s", w.Header(), w.Body.String())
	}
	token := invitationToken(t, result.InvitationURL)
	var expires time.Time
	var hash []byte
	var record string
	if err := pool.QueryRow(t.Context(), `SELECT token_hash,expires_at,to_jsonb(g)::text FROM auth_grants g WHERE kind='invite'`).Scan(&hash, &expires, &record); err != nil {
		t.Fatal(err)
	}
	if !expires.Equal(result.ExpiresAt) || time.Until(expires) < 59*time.Minute || time.Until(expires) > time.Hour || !bytes.Equal(hash, hashToken(token)) || strings.Contains(record, token) || strings.Contains(record, result.InvitationURL) {
		t.Fatal("grant secret or expiry stored incorrectly")
	}
	// No authenticated account response exposes the invitation or its token.
	if strings.Contains(admin.request("GET", "/v1/account", nil).Body.String(), token) {
		t.Fatal("account disclosed invitation")
	}
	guest := newBrowser(s)
	begin := guest.request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": token, "display_name": "admin", "name": "Recipient key"}))
	requireStatus(t, begin, 200)
	if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE token_hash=$1`, hashToken(token)) != 1 {
		t.Fatal("opening ceremony spent grant")
	}
	requireStatus(t, guest.request("POST", "/v1/auth/invite/finish", newAuthenticator(t).registration(t, begin.Body.Bytes(), s.origin, true)), 200)
	if guest.state(t)["role"] != "user" || admin.state(t)["role"] != "admin" {
		t.Fatal("display name granted privileges or setup lost admin")
	}
	requireStatus(t, guest.request("POST", invitationsPath, []byte(`{}`)), 403)
	requireStatus(t, newBrowser(s).request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": token, "display_name": "Replay"})), 403)
}

func TestInvitationRequestAuthorizationAndStrictInput(t *testing.T) {
	s, pool := testService(t)
	admin := enroll(t, s, pool)
	user, _ := inviteAuthenticator(t, s, pool, "User")
	key := admin.request("POST", "/v1/api-keys", []byte(`{"name":"Admin client"}`))
	requireStatus(t, key, 201)
	var apiKey struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(key.Body.Bytes(), &apiKey); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name         string
		client       *browser
		body, path   string
		origin       []string
		csrf, bearer string
		status       int
	}{
		{"anonymous", newBrowser(s), `{}`, invitationsPath, []string{s.origin}, "", "", 401},
		{"admin API key", newBrowser(s), `{}`, invitationsPath, []string{s.origin}, "", apiKey.Key, 401},
		{"user", user, `{}`, invitationsPath, []string{s.origin}, user.csrf, "", 403},
		{"user plus admin API key", user, `{}`, invitationsPath, []string{s.origin}, user.csrf, apiKey.Key, 403},
		{"missing origin", admin, `{}`, invitationsPath, nil, admin.csrf, "", 403},
		{"foreign origin", admin, `{}`, invitationsPath, []string{"https://evil.example"}, admin.csrf, "", 403},
		{"duplicate origin", admin, `{}`, invitationsPath, []string{s.origin, s.origin}, admin.csrf, "", 403},
		{"missing CSRF", admin, `{}`, invitationsPath, []string{s.origin}, "", "", 403},
		{"foreign CSRF", admin, `{}`, invitationsPath, []string{s.origin}, user.csrf, "", 403},
		{"role input", admin, `{"role":"admin"}`, invitationsPath, []string{s.origin}, admin.csrf, "", 400},
		{"owner input", admin, `{"account_id":"` + admin.state(t)["account_id"].(string) + `"}`, invitationsPath, []string{s.origin}, admin.csrf, "", 400},
		{"nonempty", admin, `{"token":"x"}`, invitationsPath, []string{s.origin}, admin.csrf, "", 400},
		{"query", admin, `{}`, invitationsPath + "?role=admin", []string{s.origin}, admin.csrf, "", 400},
		{"empty query", admin, `{}`, invitationsPath + "?", []string{s.origin}, admin.csrf, "", 400},
		{"null", admin, `null`, invitationsPath, []string{s.origin}, admin.csrf, "", 400},
		{"array", admin, `[]`, invitationsPath, []string{s.origin}, admin.csrf, "", 400},
		{"string", admin, `""`, invitationsPath, []string{s.origin}, admin.csrf, "", 400},
		{"empty", admin, ``, invitationsPath, []string{s.origin}, admin.csrf, "", 400},
		{"malformed", admin, `{`, invitationsPath, []string{s.origin}, admin.csrf, "", 400},
		{"trailing", admin, `{} {}`, invitationsPath, []string{s.origin}, admin.csrf, "", 400},
		{"oversized", admin, `{}` + strings.Repeat(" ", 65536), invitationsPath, []string{s.origin}, admin.csrf, "", 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", test.path, strings.NewReader(test.body))
			r.Header["Origin"] = test.origin
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", test.csrf)
			if test.bearer != "" {
				r.Header.Set("Authorization", "Bearer "+test.bearer)
			}
			for _, c := range test.client.cookies {
				r.AddCookie(c)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			requireStatus(t, w, test.status)
			if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Morsel-Account-ID") != "" || testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE kind='invite'`) != 0 {
				t.Fatal("rejected request inserted grant or disclosed identity")
			}
		})
	}
	for _, update := range []struct {
		sql    string
		status int
		code   string
	}{
		{`UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '13 hours'`, 403, "verification_required"},
		{`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second'`, 401, "unauthorized"},
	} {
		if _, err := pool.Exec(t.Context(), update.sql); err != nil {
			t.Fatal(err)
		}
		w := admin.request("POST", invitationsPath, []byte(`{}`))
		requireStatus(t, w, update.status)
		if !strings.Contains(w.Body.String(), update.code) {
			t.Fatal(w.Body.String())
		}
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE kind='invite'`) != 0 {
		t.Fatal("stale session issued invitation")
	}
}

func TestInvitationRateLimitAndIndependentParallelGrants(t *testing.T) {
	s, pool := testService(t)
	admin := enroll(t, s, pool)
	const count = 8
	results := make(chan *httptest.ResponseRecorder, count)
	var wg sync.WaitGroup
	for range count {
		client := newBrowser(s)
		client.csrf = admin.csrf
		client.cookies[sessionCookie] = admin.cookies[sessionCookie]
		wg.Add(1)
		go func() { defer wg.Done(); results <- client.request("POST", invitationsPath, []byte(`{}`)) }()
	}
	wg.Wait()
	close(results)
	seen := map[string]bool{}
	for w := range results {
		token := invitationToken(t, readInvitation(t, w).InvitationURL)
		if seen[token] {
			t.Fatal("duplicate invitation")
		}
		seen[token] = true
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE kind='invite'`) != count {
		t.Fatal("parallel requests replaced invitations")
	}
	for range 60 - count {
		readInvitation(t, admin.request("POST", invitationsPath, []byte(`{}`)))
	}
	w := admin.request("POST", invitationsPath, []byte(`{}`))
	requireStatus(t, w, 429)
	if w.Header().Get("Retry-After") != "60" || testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE kind='invite'`) != 60 {
		t.Fatal("rate limit inserted grant or omitted retry delay")
	}
	// Issuance has a fixed bucket separate from recipient authentication.
	requireStatus(t, newBrowser(s).request("POST", "/v1/auth/login/begin", []byte(`{}`)), 200)
	// Logout does not revoke already returned independent grants.
	requireStatus(t, admin.request("POST", "/v1/auth/logout", []byte(`{}`)), 204)
	for token := range seen {
		requireStatus(t, newBrowser(s).request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": token, "display_name": "Independent"})), 200)
	}
}

func TestInvitationCannotPassConcurrentAuthorizationChange(t *testing.T) {
	for _, change := range []string{"logout", "recovery", "demotion"} {
		t.Run(change, func(t *testing.T) {
			s, pool := testService(t)
			admin := enroll(t, s, pool)
			ctx := t.Context()
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			u, err := lockAccount(ctx, tx, testdb.AccountID(t, pool), 1)
			if err != nil {
				t.Fatal(err)
			}
			results := make(chan *httptest.ResponseRecorder, 1)
			go func() { results <- admin.request("POST", invitationsPath, []byte(`{}`)) }()
			waitForAccountLock(t, pool)
			status := 401
			switch change {
			case "logout":
				_, err = tx.Exec(ctx, `DELETE FROM auth_sessions WHERE account_id=$1`, u.ID)
			case "recovery":
				err = replaceCredentials(ctx, tx, u, &webauthn.Credential{ID: randomBytes(32)}, "Recovered")
			case "demotion":
				_, err = tx.Exec(ctx, `UPDATE accounts SET role='user' WHERE id=$1`, u.ID)
				status = 403
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			requireStatus(t, <-results, status)
			if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE kind='invite'`) != 0 {
				t.Fatal("authorization change allowed invitation")
			}
		})
	}
}

func TestInvitationDatabaseFailureIsClosed(t *testing.T) {
	for _, table := range []string{"accounts", "auth_sessions", "auth_grants"} {
		t.Run(table, func(t *testing.T) {
			s, pool := testService(t)
			admin := enroll(t, s, pool)
			if _, err := pool.Exec(t.Context(), `ALTER TABLE `+table+` RENAME TO unavailable_table`); err != nil {
				t.Fatal(err)
			}
			w := admin.request("POST", invitationsPath, []byte(`{}`))
			requireStatus(t, w, 503)
			if w.Header().Get("X-Morsel-Account-ID") != "" || strings.Contains(w.Body.String(), "invitation_url") {
				t.Fatal("database failure returned invitation")
			}
			if _, err := pool.Exec(t.Context(), `ALTER TABLE unavailable_table RENAME TO `+table); err != nil {
				t.Fatal(err)
			}
			if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE kind='invite'`) != 0 {
				t.Fatal("database failure committed grant")
			}
		})
	}
}

func TestSignedInInvitationRecipientMustSignOut(t *testing.T) {
	for _, role := range []string{"admin", "user"} {
		t.Run(role, func(t *testing.T) {
			s, pool := testService(t)
			signed := enroll(t, s, pool)
			if role == "user" {
				signed, _ = inviteAuthenticator(t, s, pool, "Existing user")
			}
			token, err := IssueGrant(t.Context(), pool, "invite", uuid.Nil)
			if err != nil {
				t.Fatal(err)
			}
			payload := encode(t, map[string]string{"token": token, "display_name": "Recipient"})
			originalCookie := signed.cookies[sessionCookie].Value
			assertRejected := func(w *httptest.ResponseRecorder) {
				t.Helper()
				requireStatus(t, w, 409)
				if !strings.Contains(w.Body.String(), "sign_out_required") || w.Header().Get("Set-Cookie") != "" || signed.cookies[sessionCookie].Value != originalCookie {
					t.Fatal("signed-in rejection changed session")
				}
				if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE token_hash=$1`, hashToken(token)) != 1 {
					t.Fatal("signed-in rejection spent grant")
				}
			}
			assertRejected(signed.request("POST", "/v1/auth/invite/begin", payload))
			guest := newBrowser(s)
			w := guest.request("POST", "/v1/auth/invite/begin", payload)
			requireStatus(t, w, 200)
			credential := newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
			guest.cookies[sessionCookie] = signed.cookies[sessionCookie]
			assertRejected(guest.request("POST", "/v1/auth/invite/finish", credential))
			delete(guest.cookies, sessionCookie)
			requireStatus(t, guest.request("POST", "/v1/auth/invite/finish", credential), 200)
			if guest.state(t)["role"] != "user" {
				t.Fatal("invitation promoted recipient")
			}
		})
	}
}

func TestInvitationRecipientInvalidSessionsAndDatabaseFailure(t *testing.T) {
	for _, state := range []string{"invalid", "expired", "generation changed", "database failure"} {
		t.Run(state, func(t *testing.T) {
			s, pool := testService(t)
			admin := enroll(t, s, pool)
			token, err := IssueGrant(t.Context(), pool, "invite", uuid.Nil)
			if err != nil {
				t.Fatal(err)
			}
			guest := newBrowser(s)
			guest.cookies[sessionCookie] = admin.cookies[sessionCookie]
			switch state {
			case "invalid":
				guest.cookies[sessionCookie] = &http.Cookie{Name: sessionCookie, Value: randomToken()}
			case "expired":
				_, err = pool.Exec(t.Context(), `UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second'`)
			case "generation changed":
				_, err = pool.Exec(t.Context(), `UPDATE accounts SET auth_generation=2`)
			case "database failure":
				_, err = pool.Exec(t.Context(), `ALTER TABLE auth_sessions RENAME TO unavailable_sessions`)
			}
			if err != nil {
				t.Fatal(err)
			}
			payload := encode(t, map[string]string{"token": token, "display_name": "Recipient"})
			w := guest.request("POST", "/v1/auth/invite/begin", payload)
			if state == "database failure" {
				requireStatus(t, w, 503)
				requireStatus(t, guest.request("POST", "/v1/auth/invite/finish", []byte(`{}`)), 503)
				if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE token_hash=$1`, hashToken(token)) != 1 {
					t.Fatal("database failure spent grant")
				}
				return
			}
			requireStatus(t, w, 200)
			requireStatus(t, guest.request("POST", "/v1/auth/invite/finish", newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)), 200)
			if guest.state(t)["role"] != "user" {
				t.Fatal("invalid session prevented user registration")
			}
		})
	}
}

func TestAccountRolesAreDatabaseBackedAndRecoveryPreservesRole(t *testing.T) {
	s, pool := testService(t)
	admin, a := enrollAuthenticator(t, s, pool)
	user, b := inviteAuthenticator(t, s, pool, "Admin")
	if _, ok := newBrowser(s).state(t)["role"]; ok {
		t.Fatal("signed-out account response includes role")
	}
	for _, test := range []struct {
		client *browser
		a      *authenticator
		role   string
	}{{admin, a, "admin"}, {user, b, "user"}} {
		if test.client.state(t)["role"] != test.role || loginAuthenticator(t, s, test.a).state(t)["role"] != test.role {
			t.Fatal("login lost stored role")
		}
		id := uuid.Must(uuid.FromBytes(test.a.user))
		token, err := IssueGrant(t.Context(), pool, "recover", id)
		if err != nil {
			t.Fatal(err)
		}
		recovery := newBrowser(s)
		w := recovery.request("POST", "/v1/auth/recover/begin", encode(t, map[string]string{"token": token}))
		requireStatus(t, w, 200)
		requireStatus(t, recovery.request("POST", "/v1/auth/recover/finish", newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)), 200)
		if recovery.state(t)["role"] != test.role {
			t.Fatal("recovery reassigned role")
		}
		if _, err = pool.Exec(t.Context(), `UPDATE accounts SET role='user' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		if recovery.state(t)["role"] != "user" {
			t.Fatal("account response cached role")
		}
		requireStatus(t, recovery.request("POST", invitationsPath, []byte(`{}`)), 403)
	}
}

func TestRegistrationCannotChooseRole(t *testing.T) {
	s, pool := testService(t)
	setup, err := IssueGrant(t.Context(), pool, "setup", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"role", "account_role", "admin"} {
		requireStatus(t, newBrowser(s).request("POST", "/v1/auth/setup/begin", encode(t, map[string]string{"token": setup, field: "admin"})), 400)
	}
	enroll(t, s, pool)
	token, err := IssueGrant(t.Context(), pool, "invite", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"role", "account_role", "admin"} {
		requireStatus(t, newBrowser(s).request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": token, "display_name": "Admin", field: "admin"})), 400)
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM accounts WHERE role='admin'`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM accounts`) != 1 {
		t.Fatal("role input created account")
	}
}

func TestAdminRoleDoesNotBypassShareOwnership(t *testing.T) {
	s, pool := testService(t)
	admin, a := enrollAuthenticator(t, s, pool)
	user, b := inviteAuthenticator(t, s, pool, "User")
	repository := share.NewPostgresRepository(pool)
	for _, owner := range []*authenticator{a, b} {
		id := uuid.New()
		token, hash, err := (share.TokenGenerator{}).Generate()
		if err != nil {
			t.Fatal(err)
		}
		if _, err = repository.Create(t.Context(), share.CreateParams{AccountID: uuid.Must(uuid.FromBytes(owner.user)), ID: id, TokenHash: hash, Content: "Private content"}); err != nil {
			t.Fatal(err)
		}
		foreign := user
		if owner == b {
			foreign = admin
		}
		path := "/v1/account/shares/" + id.String()
		for _, req := range []struct {
			method, path string
			body         []byte
		}{{"GET", path, nil}, {"DELETE", path, nil}, {"GET", path + "/link", nil}, {"POST", path + "/link", encode(t, map[string]string{"token": token})}} {
			requireStatus(t, foreign.request(req.method, req.path, req.body), 404)
		}
		if _, err = repository.Consume(t.Context(), hash); err != nil {
			t.Fatal("role changed public capability access")
		}
	}
	for _, client := range []*browser{admin, user} {
		w := client.request("GET", "/v1/account/shares", nil)
		requireStatus(t, w, 200)
		var page share.AdminPage
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != 1 {
			t.Fatal("role bypassed share list ownership")
		}
	}
}
