package auth

import (
	"github.com/google/uuid"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestCanonicalOriginHTTPChecks(t *testing.T) {
	_, pool := testService(t)
	for _, test := range []struct{ configured, origin, wrong string }{
		{"https://Morsel.Example:443", "https://morsel.example", "https://morsel.example:8443"},
		{"http://LOCALHOST:80", "http://localhost", "http://localhost:5173"},
		{"http://LOCALHOST:5173", "http://localhost:5173", "http://localhost:5174"},
	} {
		t.Run(test.configured, func(t *testing.T) {
			u, _ := url.Parse(test.configured)
			s, err := NewService(pool, u)
			if err != nil {
				t.Fatal(err)
			}
			for _, origin := range []string{test.origin, test.wrong} {
				r := httptest.NewRequest("POST", "/v1/auth/login/begin", strings.NewReader(`{}`))
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Origin", origin)
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				if origin == test.origin {
					requireStatus(t, w, 200)
				} else {
					requireStatus(t, w, 403)
				}
			}
			r := httptest.NewRequest("POST", "/v1/auth/login/begin", strings.NewReader(`{}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Add("Origin", test.origin)
			r.Header.Add("Origin", test.wrong)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			requireStatus(t, w, 403)
		})
	}
}

func TestRegistrationRejectsWrongRPID(t *testing.T) {
	s, pool := testService(t)
	token, err := IssueGrant(t.Context(), pool, "setup", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	b := newBrowser(s)
	w := b.request("POST", "/v1/auth/setup/begin", encode(t, map[string]string{"token": token}))
	requireStatus(t, w, 200)
	options := challenge(t, w.Body.Bytes())
	options["rp"].(map[string]any)["id"] = "other.example"
	credential := newAuthenticator(t).registration(t, encode(t, map[string]any{"publicKey": options}), s.origin, true)
	requireStatus(t, b.request("POST", "/v1/auth/setup/finish", credential), 400)
}
