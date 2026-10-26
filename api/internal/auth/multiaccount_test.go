package auth

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func inviteAuthenticator(t *testing.T, s *Service, pool *pgxpool.Pool, displayName string) (*browser, *authenticator) {
	t.Helper()
	token, err := IssueGrant(t.Context(), pool, "invite", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	b := newBrowser(s)
	w := b.request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": token, "display_name": displayName, "name": "Invited passkey"}))
	requireStatus(t, w, 200)
	user := challenge(t, w.Body.Bytes())["user"].(map[string]any)
	if user["displayName"] != displayName || user["name"] == "owner" {
		t.Fatal("registration did not use account-specific names")
	}
	a := newAuthenticator(t)
	requireStatus(t, b.request("POST", "/v1/auth/invite/finish", a.registration(t, w.Body.Bytes(), s.origin, true)), 200)
	if b.state(t)["display_name"] != displayName {
		t.Fatal("invitation lost account display name")
	}
	return b, a
}

func loginAuthenticator(t *testing.T, s *Service, a *authenticator) *browser {
	t.Helper()
	b := newBrowser(s)
	w := b.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	requireStatus(t, b.request("POST", "/v1/auth/login/finish", a.assertion(t, w.Body.Bytes(), s.origin, true)), 200)
	b.state(t)
	return b
}

func TestTwoAccountLoginAndManagementIdentity(t *testing.T) {
	s, pool := testService(t)
	first, a := enrollAuthenticator(t, s, pool)
	second, b := inviteAuthenticator(t, s, pool, "Second account")
	for _, test := range []struct {
		client *browser
		a      *authenticator
	}{{first, a}, {second, b}} {
		id := uuid.Must(uuid.FromBytes(test.a.user)).String()
		if test.client.state(t)["account_id"] != id || loginAuthenticator(t, s, test.a).state(t)["account_id"] != id {
			t.Fatal("discoverable login selected another account")
		}
		for _, path := range []string{"/v1/account", "/v1/api-keys", "/v1/passkeys"} {
			w := test.client.request("GET", path, nil)
			requireStatus(t, w, 200)
			if w.Header().Get("X-Morsel-Account-ID") != id {
				t.Fatalf("%s missing authorized identity", path)
			}
		}
		w := test.client.request("POST", "/v1/api-keys", []byte(`{"name":"CLI"}`))
		requireStatus(t, w, 201)
		if w.Header().Get("X-Morsel-Account-ID") != id {
			t.Fatal("one-time key missing identity")
		}
		var key struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &key); err != nil {
			t.Fatal(err)
		}
		got, err := s.Authenticate(t.Context(), "Bearer "+key.Key)
		if err != nil || got.String() != id {
			t.Fatalf("key identity=%s err=%v", got, err)
		}
	}
	if first.state(t)["account_id"] == second.state(t)["account_id"] {
		t.Fatal("invitation reused first account")
	}
	// A real foreign credential must not step up the current account.
	w := first.request("POST", "/v1/auth/verify/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	requireStatus(t, first.request("POST", "/v1/auth/verify/finish", b.assertion(t, w.Body.Bytes(), s.origin, true)), 400)
	// A credential ID and another valid account's user handle fail identically
	// to an unknown credential; neither creates a session.
	var failures [][]byte
	for _, mismatch := range []bool{true, false} {
		client := newBrowser(s)
		w := client.request("POST", "/v1/auth/login/begin", []byte(`{}`))
		requireStatus(t, w, 200)
		forged := *a
		if mismatch {
			forged.user = b.user
		} else {
			forged.id = randomBytes(32)
		}
		w = client.request("POST", "/v1/auth/login/finish", forged.assertion(t, w.Body.Bytes(), s.origin, true))
		requireStatus(t, w, 400)
		failures = append(failures, w.Body.Bytes())
	}
	if !bytes.Equal(failures[0], failures[1]) {
		t.Fatal("credential lookup leaks account existence")
	}
}

func TestIndependentInviteGrantsAndConcurrentRedemption(t *testing.T) {
	s, pool := testService(t)
	enroll(t, s, pool)
	first, err := IssueGrant(t.Context(), pool, "invite", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := IssueGrant(t.Context(), pool, "invite", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	if testdb.Count(t, pool, `SELECT count(*) FROM auth_grants WHERE kind='invite'`) != 2 {
		t.Fatal("invites canceled each other")
	}
	clients := []*browser{newBrowser(s), newBrowser(s)}
	bodies := make([][]byte, 2)
	for i, b := range clients {
		w := b.request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": first, "display_name": "Invited"}))
		requireStatus(t, w, 200)
		bodies[i] = newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
	}
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 2)
	for i, b := range clients {
		wg.Add(1)
		go func() { defer wg.Done(); results <- b.request("POST", "/v1/auth/invite/finish", bodies[i]) }()
	}
	wg.Wait()
	close(results)
	wins := 0
	for w := range results {
		if w.Code == 200 {
			wins++
		} else if w.Code != 403 {
			t.Fatalf("unexpected invite result %d %s", w.Code, w.Body.String())
		}
	}
	if wins != 1 || testdb.Count(t, pool, `SELECT count(*) FROM accounts`) != 2 {
		t.Fatal("invitation redeemed more than once")
	}
	request := func(token string) *httptest.ResponseRecorder {
		return newBrowser(s).request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": token, "display_name": "Another"}))
	}
	requireStatus(t, request(first), 403)
	expiring := newBrowser(s)
	w := expiring.request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": second, "display_name": "Expiring"}))
	requireStatus(t, w, 200)
	credential := newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
	if _, err = pool.Exec(t.Context(), `UPDATE auth_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, hashToken(second)); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, expiring.request("POST", "/v1/auth/invite/finish", credential), 403)
	requireStatus(t, expiring.request("POST", "/v1/auth/invite/finish", credential), 400)
	requireStatus(t, request(second), 403)
	if testdb.Count(t, pool, `SELECT count(*) FROM accounts`) != 2 {
		t.Fatal("expired invitation created an account")
	}
}

func TestRecoveryIsAccountLocal(t *testing.T) {
	s, pool := testService(t)
	first, a := enrollAuthenticator(t, s, pool)
	second, b := inviteAuthenticator(t, s, pool, "Second")
	aID := uuid.Must(uuid.FromBytes(a.user))
	bID := uuid.Must(uuid.FromBytes(b.user))
	keys := make(map[uuid.UUID]string)
	for id, client := range map[uuid.UUID]*browser{aID: first, bID: second} {
		w := client.request("POST", "/v1/api-keys", []byte(`{"name":"Retained"}`))
		requireStatus(t, w, 201)
		var key struct {
			Key string `json:"key"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &key); err != nil {
			t.Fatal(err)
		}
		keys[id] = key.Key
	}
	invite, err := IssueGrant(t.Context(), pool, "invite", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	grantA, err := IssueGrant(t.Context(), pool, "recover", aID)
	if err != nil {
		t.Fatal(err)
	}
	grantB, err := IssueGrant(t.Context(), pool, "recover", bID)
	if err != nil {
		t.Fatal(err)
	}
	replacementA, err := IssueGrant(t.Context(), pool, "recover", aID)
	if err != nil {
		t.Fatal(err)
	}
	beginRecovery := func(token string) (*browser, *httptest.ResponseRecorder) {
		client := newBrowser(s)
		return client, client.request("POST", "/v1/auth/recover/begin", encode(t, map[string]string{"token": token}))
	}
	_, w := beginRecovery(grantA)
	requireStatus(t, w, 403)
	_, w = beginRecovery(grantB)
	requireStatus(t, w, 200)
	pending := newBrowser(s)
	w = pending.request("POST", "/v1/auth/login/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	assertionB := b.assertion(t, w.Body.Bytes(), s.origin, true)
	recovery, w := beginRecovery(replacementA)
	requireStatus(t, w, 200)
	if got := challenge(t, w.Body.Bytes())["user"].(map[string]any)["id"]; got != b64(a.user) {
		t.Fatal("recovery selected wrong grant account")
	}
	requireStatus(t, recovery.request("POST", "/v1/auth/recover/finish", newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)), 200)
	if first.state(t)["authenticated"] != false || second.state(t)["account_id"] != bID.String() {
		t.Fatal("recovery invalidated wrong sessions")
	}
	requireStatus(t, pending.request("POST", "/v1/auth/login/finish", assertionB), 200)
	_, w = beginRecovery(grantB)
	requireStatus(t, w, 200)
	if testdb.Count(t, pool, `SELECT count(*) FROM passkey_credentials WHERE account_id=$1`, bID) != 1 {
		t.Fatal("recovery deleted foreign credential")
	}
	for id, key := range keys {
		got, err := s.Authenticate(t.Context(), "Bearer "+key)
		if err != nil || got != id {
			t.Fatal("recovery changed an API key")
		}
	}
	requireStatus(t, newBrowser(s).request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": invite, "display_name": "Still valid"})), 200)
}

func TestLoginRegistrationOrderIgnoresWallClock(t *testing.T) {
	for _, timestamp := range []string{"clock_timestamp()", "'2000-01-01'::timestamptz"} {
		t.Run(timestamp, func(t *testing.T) {
			s, pool := testService(t)
			owner, original := enrollAuthenticator(t, s, pool)
			oldLogin := newBrowser(s)
			w := oldLogin.request("POST", "/v1/auth/login/begin", []byte(`{}`))
			requireStatus(t, w, 200)
			options := append([]byte(nil), w.Body.Bytes()...)
			added := addPasskey(t, owner, "Added later")
			// Deliberately equal or backwards created_at values cannot make a new
			// credential eligible for a challenge issued before its registration.
			if _, err := pool.Exec(t.Context(), `UPDATE passkey_credentials SET created_at=`+timestamp); err != nil {
				t.Fatal(err)
			}
			requireStatus(t, oldLogin.request("POST", "/v1/auth/login/finish", added.assertion(t, options, s.origin, true)), 400)
			loginAuthenticator(t, s, added)
			loginAuthenticator(t, s, original)
		})
	}
}

func TestBoundFlowAndMutationIdentity(t *testing.T) {
	s, pool := testService(t)
	first, a := enrollAuthenticator(t, s, pool)
	second, _ := inviteAuthenticator(t, s, pool, "Second")
	id := uuid.Must(uuid.FromBytes(a.user)).String()
	checkIdentity := func(w *httptest.ResponseRecorder, status int) {
		t.Helper()
		requireStatus(t, w, status)
		if w.Header().Get("X-Morsel-Account-ID") != id {
			t.Fatal("authenticated response lost its authorized account")
		}
	}
	for _, kind := range []string{"verify", "passkey"} {
		w := first.request("POST", "/v1/auth/"+kind+"/begin", []byte(`{}`))
		checkIdentity(w, 200)
		var body []byte
		if kind == "verify" {
			body = a.assertion(t, w.Body.Bytes(), s.origin, true)
		} else {
			body = newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
		}
		second.cookies[flowCookie] = first.cookies[flowCookie]
		requireStatus(t, second.request("POST", "/v1/auth/"+kind+"/finish", body), 401)
		// A rejected foreign finish consumes the flow, without changing either account.
		requireStatus(t, first.request("POST", "/v1/auth/"+kind+"/finish", body), 400)
		w = first.request("POST", "/v1/auth/"+kind+"/begin", []byte(`{}`))
		checkIdentity(w, 200)
		if kind == "verify" {
			body = a.assertion(t, w.Body.Bytes(), s.origin, true)
		} else {
			body = newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
		}
		checkIdentity(first.request("POST", "/v1/auth/"+kind+"/finish", body), 200)
	}
	checkIdentity(first.request("DELETE", "/v1/passkeys/"+credentialID(a.id), nil), 204)
	checkIdentity(first.request("DELETE", "/v1/api-keys/"+uuid.NewString(), nil), 204)
	checkIdentity(first.request("POST", "/v1/auth/logout", []byte(`{}`)), 204)
	if second.state(t)["authenticated"] != true {
		t.Fatal("logout changed foreign session")
	}
}

func TestRegistrationDisplayNameValidation(t *testing.T) {
	s, pool := testService(t)
	if _, err := IssueGrant(t.Context(), pool, "invite", uuid.Nil); err == nil {
		t.Fatal("invitation bypassed initial setup")
	}
	enroll(t, s, pool)
	token, err := IssueGrant(t.Context(), pool, "invite", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", "  ", "invalid\nname"} {
		w := newBrowser(s).request("POST", "/v1/auth/invite/begin", encode(t, map[string]string{"token": token, "display_name": name}))
		requireStatus(t, w, 400)
	}
	for _, kind := range []string{"setup", "invite"} {
		if _, err = IssueGrant(t.Context(), pool, kind, uuid.New()); err == nil {
			t.Fatalf("%s accepted bound account", kind)
		}
	}
	if _, err = IssueGrant(t.Context(), pool, "recover", uuid.Nil); err == nil {
		t.Fatal("untargeted recovery accepted")
	}
	if _, err = IssueGrant(t.Context(), pool, "recover", uuid.New()); err == nil {
		t.Fatal("missing account recovery accepted")
	}
}
