package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuthenticator(t *testing.T) {
	key := strings.Repeat("a", 32)
	authenticator := New([]string{key, strings.Repeat("b", 32)})
	for _, test := range []struct {
		header string
		valid  bool
	}{
		{header: "Bearer " + key, valid: true},
		{header: "Bearer invalid", valid: false},
		{header: "bearer " + key, valid: false},
		{header: "Bearer", valid: false},
		{header: "Bearer " + key + " extra", valid: false},
		{header: "", valid: false},
	} {
		if got := authenticator.Valid(test.header); got != test.valid {
			t.Fatalf("Valid(%q)=%v", test.header, got)
		}
	}
}

func TestMiddleware(t *testing.T) {
	key := strings.Repeat("a", 32)
	authenticator := New([]string{key})
	handler := authenticator.Middleware(func(r *http.Request) bool { return r.URL.Path == "/protected" })(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }),
	)
	for _, test := range []struct {
		path   string
		header string
		status int
	}{
		{path: "/public", status: http.StatusNoContent},
		{path: "/protected", status: http.StatusUnauthorized},
		{path: "/protected", header: "Bearer " + key, status: http.StatusNoContent},
	} {
		request := httptest.NewRequest(http.MethodGet, test.path, nil)
		request.Header.Set("Authorization", test.header)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("%s: status=%d body=%s", test.path, response.Code, response.Body.String())
		}
	}
}
