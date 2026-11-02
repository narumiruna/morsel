package api

import (
	"context"
	"net/http"

	"github.com/google/uuid"
)

// Keep principal construction private to the API package. Only MCP can use the
// optional OAuth verifier; REST still calls the legacy API-key authenticator.
func authenticateMCPBearer(authenticator BearerAuthenticator) func(http.Handler) http.Handler {
	oauth, ok := authenticator.(mcpBearerAuthenticator)
	if !ok {
		return authenticateBearer(authenticator)
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Metadata is configuration-derived. Initial offline_access is
			// required because Pi uses challenge scope instead of PRM scopes.
			challenge := `Bearer realm="morsel", resource_metadata="` + oauth.MCPResourceMetadataURL() + `", scope="mcp:shares offline_access"`
			if len(r.Header.Values("Authorization")) > 1 {
				w.Header().Set("WWW-Authenticate", challenge)
				writePublicError(w, 401, ErrorCodeUnauthorized, "valid MCP access token or API key required")
				return
			}
			id, insufficient, err := oauth.AuthenticateMCP(r.Context(), r.Header.Get("Authorization"))
			if err != nil {
				writePublicError(w, 503, ErrorCodeServiceUnavailable, "authentication is unavailable")
				return
			}
			if insufficient {
				w.Header().Set("WWW-Authenticate", challenge+`, error="insufficient_scope"`)
				writePublicError(w, 403, ErrorCodeUnauthorized, "MCP share permission required")
				return
			}
			if id == uuid.Nil {
				w.Header().Set("WWW-Authenticate", challenge)
				writePublicError(w, 401, ErrorCodeUnauthorized, "valid MCP access token or API key required")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, trustedPrincipal{accountID: id})))
		})
	}
}
