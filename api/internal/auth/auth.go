package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

type Authenticator struct {
	hashes [][sha256.Size]byte
}

func New(keys []string) *Authenticator {
	hashes := make([][sha256.Size]byte, len(keys))
	for i, key := range keys {
		hashes[i] = sha256.Sum256([]byte(key))
	}
	return &Authenticator{hashes: hashes}
}

func (a *Authenticator) Valid(header string) bool {
	parts := strings.Split(header, " ")
	if len(parts) != 2 || parts[0] != "Bearer" || parts[1] == "" {
		return false
	}
	candidate := sha256.Sum256([]byte(parts[1]))
	valid := 0
	for _, expected := range a.hashes {
		valid |= subtle.ConstantTimeCompare(candidate[:], expected[:])
	}
	return valid == 1
}

func (a *Authenticator) Middleware(protected func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if protected(r) && !a.Valid(r.Header.Get("Authorization")) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("WWW-Authenticate", `Bearer realm="morsel"`)
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]string{
					"code": "unauthorized", "message": "valid API key required",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
