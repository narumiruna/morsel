package auth

import (
	"bytes"
	"context"
	"io"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestPendingFinishesCannotCommitAfterRecovery(t *testing.T) {
	for _, kind := range []string{"login", "passkey", "verify"} {
		t.Run(kind, func(t *testing.T) {
			s, pool := testService(t)
			b, a := enrollAuthenticator(t, s, pool)
			ctx := t.Context()
			w := b.request("POST", "/v1/auth/"+kind+"/begin", []byte(`{}`))
			requireStatus(t, w, 200)
			var credential []byte
			if kind == "passkey" {
				credential = newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
			} else {
				credential = a.assertion(t, w.Body.Bytes(), s.origin, true)
			}
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			u, err := lockAccount(ctx, tx, testdb.AccountID(t, pool), 1)
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() { result <- b.request("POST", "/v1/auth/"+kind+"/finish", credential) }()
			waitForAccountLock(t, pool)
			if err = replaceCredentials(ctx, tx, u, &webauthn.Credential{ID: randomBytes(32)}, "Replacement"); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			status := 401
			if kind == "login" {
				status = 400
			}
			requireStatus(t, <-result, status)
			if testdb.Count(t, pool, `SELECT count(*) FROM auth_sessions`) != 0 || testdb.Count(t, pool, `SELECT count(*) FROM passkey_credentials`) != 1 {
				t.Fatal("pending finish escaped recovery")
			}
		})
	}
}

type blockedReader struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	body    io.Reader
}

func (b *blockedReader) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.entered); <-b.release })
	return b.body.Read(p)
}
func TestSlowFinishDoesNotLockAccount(t *testing.T) {
	for _, kind := range []string{"login", "passkey"} {
		t.Run(kind, func(t *testing.T) {
			s, pool := testService(t)
			b, a := enrollAuthenticator(t, s, pool)
			w := b.request("POST", "/v1/auth/"+kind+"/begin", []byte(`{}`))
			requireStatus(t, w, 200)
			var credential []byte
			if kind == "login" {
				credential = a.assertion(t, w.Body.Bytes(), s.origin, true)
			} else {
				credential = newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
			}
			slow := &blockedReader{entered: make(chan struct{}), release: make(chan struct{}), body: bytes.NewReader(credential)}
			var once sync.Once
			unblock := func() { once.Do(func() { close(slow.release) }) }
			defer unblock()
			r := httptest.NewRequest("POST", "/v1/auth/"+kind+"/finish", slow)
			r.Header.Set("Origin", s.origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", b.csrf)
			for _, cookie := range b.cookies {
				r.AddCookie(cookie)
			}
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() { w := httptest.NewRecorder(); s.ServeHTTP(w, r); result <- w }()
			select {
			case <-slow.entered:
			case <-time.After(3 * time.Second):
				t.Fatal("finish did not read body")
			}
			// Both account state and operator recovery need the account lock. Neither
			// may wait for the network read in the unfinished ceremony.
			other := newBrowser(s)
			other.cookies[sessionCookie] = b.cookies[sessionCookie]
			stateResult := make(chan *httptest.ResponseRecorder, 1)
			go func() { stateResult <- other.request("GET", "/v1/account", nil) }()
			select {
			case state := <-stateResult:
				requireStatus(t, state, 200)
			case <-time.After(time.Second):
				t.Fatal("slow body locked account state")
			}
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			if _, err := IssueGrant(ctx, pool, "recover", testdb.AccountID(t, pool)); err != nil {
				t.Fatalf("slow body blocked recovery: %v", err)
			}
			unblock()
			requireStatus(t, <-result, 200)
		})
	}
}

func TestConcurrentRecoveryGrantCompletion(t *testing.T) {
	s, pool := testService(t)
	enroll(t, s, pool)
	token, err := IssueGrant(t.Context(), pool, "recover", testdb.AccountID(t, pool))
	if err != nil {
		t.Fatal(err)
	}
	clients := []*browser{newBrowser(s), newBrowser(s)}
	bodies := make([][]byte, 2)
	for i, b := range clients {
		w := b.request("POST", "/v1/auth/recover/begin", encode(t, map[string]string{"token": token}))
		requireStatus(t, w, 200)
		bodies[i] = newAuthenticator(t).registration(t, w.Body.Bytes(), s.origin, true)
	}
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i, b := range clients {
		wg.Add(1)
		go func(i int, b *browser) {
			defer wg.Done()
			statuses <- b.request("POST", "/v1/auth/recover/finish", bodies[i]).Code
		}(i, b)
	}
	wg.Wait()
	close(statuses)
	successes := 0
	for status := range statuses {
		if status == 200 {
			successes++
		} else if status != 400 && status != 401 && status != 403 {
			t.Fatalf("unexpected recovery status %d", status)
		}
	}
	if successes != 1 || testdb.Count(t, pool, `SELECT count(*) FROM accounts WHERE auth_generation=2`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM passkey_credentials`) != 1 || testdb.Count(t, pool, `SELECT count(*) FROM auth_grants`) != 0 {
		t.Fatal("recovery grant reused")
	}
}
