package api

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/narumiruna/morsel/api/internal/share"
)

func TestBearerAuthenticationFailsClosed(t *testing.T) {
	for _, test := range []struct {
		name   string
		auth   BearerAuthenticator
		status int
	}{
		{name: "no authenticator", status: http.StatusUnauthorized},
		{name: "database unavailable", auth: authenticatorStub{err: errors.New("private database failure")}, status: http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &repositoryStub{}
			origin, _ := url.Parse("https://morsel.example/")
			handler := NewRouter(NewService(repository, share.TokenGenerator{}, origin, 100, slog.Default()), RouterConfig{
				Authenticator: test.auth, Logger: slog.Default(), MaxRequestBody: 1024, RequestTimeout: time.Second,
			})
			for _, endpoint := range []struct{ method, path string }{
				{http.MethodPost, "/v1/shares"},
				{http.MethodDelete, "/v1/shares/00000000-0000-0000-0000-000000000000"},
			} {
				response := request(t, handler, endpoint.method, endpoint.path, `{"content":"private"}`, "Bearer "+testAPIKey)
				if response.Code != test.status || strings.Contains(response.Body.String(), "private") {
					t.Fatalf("%s %s: status=%d body=%s", endpoint.method, endpoint.path, response.Code, response.Body.String())
				}
			}
			if len(repository.created) != 0 {
				t.Fatal("unauthorized request reached repository")
			}
			if got := request(t, handler, http.MethodGet, "/healthz", "", "").Code; got != http.StatusOK {
				t.Fatalf("public health route=%d", got)
			}
		})
	}
}

func TestRouterMountsAccountRoutesWithoutRequiringBearer(t *testing.T) {
	origin, _ := url.Parse("https://morsel.example/")
	calls := 0
	handler := NewRouter(NewService(&repositoryStub{}, share.TokenGenerator{}, origin, 100, slog.Default()), RouterConfig{
		Account: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			deadline, ok := r.Context().Deadline()
			if !ok || time.Until(deadline) > time.Second {
				t.Error("account route lost request timeout")
			}
			calls++
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusNoContent)
		}), Logger: slog.Default(), MaxRequestBody: 1024, RequestTimeout: time.Second,
	})
	for _, path := range []string{"/v1/account", "/v1/account/shares", "/v1/account/shares/id", "/v1/auth/login/begin", "/v1/passkeys", "/v1/passkeys/credential", "/v1/api-keys", "/v1/api-keys/id"} {
		response := request(t, handler, http.MethodPost, path, `{}`, "")
		if response.Code != http.StatusNoContent || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
	}
	if calls != 8 {
		t.Fatalf("account calls=%d", calls)
	}
	if got := request(t, handler, http.MethodGet, "/v1/unknown", "", "").Code; got != http.StatusNotFound {
		t.Fatalf("unknown API status=%d", got)
	}
}
