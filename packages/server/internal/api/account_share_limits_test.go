package api

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/narumiruna/morsel/packages/server/internal/share"
)

func TestAccountShareMountPreservesBodyLimit(t *testing.T) {
	origin, _ := url.Parse("https://morsel.example/")
	handler := NewRouter(NewService(&repositoryStub{}, share.TokenGenerator{}, origin, 100, slog.Default()), RouterConfig{
		Account: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, err := io.ReadAll(r.Body)
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				return
			}
			t.Errorf("body limit not applied: %v", err)
		}),
		Logger: slog.Default(), MaxRequestBody: 16, RequestTimeout: time.Second,
	})
	for _, path := range []string{"/v1/account/shares", "/v1/account/shares/id"} {
		w := request(t, handler, http.MethodPost, path, strings.Repeat("x", 17), "")
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("%s body limit status=%d", path, w.Code)
		}
	}
}
