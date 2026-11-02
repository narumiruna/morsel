package api

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpRequestContextKey struct{}

type mcpHTTPContext struct {
	ctx context.Context
	mu  sync.Mutex
}

type mcpBearerAuthenticator interface {
	AuthenticateMCP(context.Context, string) (uuid.UUID, bool, error)
	MCPResourceMetadataURL() string
}

// NewMCPHandler serves stateless Streamable HTTP with API keys or MCP OAuth.
// The configured public authority is required, including behind a reverse proxy.
func NewMCPHandler(service *Service, authenticator BearerAuthenticator, maxRequestBytes int64) http.Handler {
	server := mcp.NewServer(&mcp.Implementation{Name: "morsel", Version: "dev"}, &mcp.ServerOptions{
		SupportedProtocolVersions: []string{"2025-11-25", "2025-06-18", "2025-03-26"},
		Capabilities:              &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{}},
	})
	server.AddReceivingMiddleware(mcpRequestContext)
	service.addMCPTools(server)
	transport := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{
		Stateless: true, JSONResponse: true, MaxRequestBodyBytes: maxRequestBytes,
		// The SDK rejects public Host headers on loopback sockets. The stricter
		// configured-authority check below also protects non-loopback listeners.
		DisableLocalhostProtection: true,
	})
	authenticated := authenticateMCPBearer(authenticator)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), mcpRequestContextKey{}, &mcpHTTPContext{ctx: r.Context()})
		transport.ServeHTTP(w, r.WithContext(ctx))
	}))
	public := service.publicViewerURL
	authority := canonicalMCPAuthority(public.Scheme, public.Host)
	if authority == "" || maxRequestBytes <= 0 {
		panic("invalid MCP configuration")
	}
	origin := strings.ToLower(public.Scheme) + "://" + authority
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		response := &mcpResponseWriter{ResponseWriter: w, ctx: r.Context()}
		response.Header().Set("Cache-Control", "no-store")
		if canonicalMCPAuthority(public.Scheme, r.Host) != authority {
			writePublicError(response, http.StatusForbidden, ErrorCodeInvalidRequest, "configured application Host required")
			return
		}
		if values := r.Header.Values("Origin"); len(values) != 0 && (len(values) != 1 || values[0] != origin) {
			writePublicError(response, http.StatusForbidden, ErrorCodeInvalidRequest, "exact application Origin required")
			return
		}
		authenticated.ServeHTTP(response, r)
		if !response.wroteHeader {
			// The SDK can finish without committing headers when the HTTP context
			// ends. Do not report an empty 200 response after a request deadline.
			response.Header().Set("Cache-Control", "no-store")
			if mcpDeadlineExceeded(r.Context()) {
				writePublicError(response, http.StatusGatewayTimeout, ErrorCodeServiceUnavailable, "request timed out")
			}
		}
	})
}

// mcpRequestContext restores the HTTP lifetime that the SDK detaches for legacy
// protocol sessions. Only the advertised JSON-only tool methods are available.
func mcpRequestContext(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
		switch method {
		case "initialize", "notifications/initialized", "notifications/cancelled", "ping", "tools/list", "tools/call":
		default:
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeMethodNotFound, Message: "method not found"}
		}
		state, _ := ctx.Value(mcpRequestContextKey{}).(*mcpHTTPContext)
		if state == nil || authorizedAccount(state.ctx) == uuid.Nil {
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeInvalidRequest, Message: "authenticated HTTP request required"}
		}
		// The 2025-03-26 protocol permits batches. Serialize calls within one
		// HTTP request because its telemetry has one mutable share marker.
		state.mu.Lock()
		defer state.mu.Unlock()
		httpContext := state.ctx
		var cancel context.CancelFunc
		if deadline, ok := httpContext.Deadline(); ok {
			ctx, cancel = context.WithDeadline(ctx, deadline)
		} else {
			ctx, cancel = context.WithCancel(ctx)
		}
		defer cancel()
		stop := context.AfterFunc(httpContext, cancel)
		defer stop()
		if httpContext.Err() != nil || mcpDeadlineExceeded(httpContext) {
			cancel()
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeInvalidRequest, Message: "request canceled"}
		}
		return next(ctx, method, request)
	}
}

// Parent and restored SDK contexts have independent deadline timers. Check the
// deadline itself: the operation timer can fire before the HTTP timer callback.
func mcpDeadlineExceeded(ctx context.Context) bool {
	deadline, ok := ctx.Deadline()
	return errors.Is(ctx.Err(), context.DeadlineExceeded) || (ok && !time.Now().Before(deadline))
}

// canonicalMCPAuthority accepts only a plain authority. Default ports and host
// case use the same normalization as account authentication; Origin stays exact.
func canonicalMCPAuthority(scheme, authority string) string {
	u, err := url.Parse(strings.ToLower(scheme) + "://" + authority)
	if err != nil || u.Host != authority || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.HasSuffix(authority, ":") {
		return ""
	}
	host, port := strings.ToLower(u.Hostname()), u.Port()
	if port != "" {
		if number, err := strconv.ParseUint(port, 10, 16); err != nil || number == 0 {
			return ""
		}
	}
	if (strings.EqualFold(scheme, "https") && port == "443") || (strings.EqualFold(scheme, "http") && port == "80") {
		port = ""
	}
	if port != "" {
		return net.JoinHostPort(host, port)
	}
	if strings.Contains(host, ":") {
		return "[" + host + "]"
	}
	return host
}

// Enforce no-store at commitment: the SDK writes its own cache header even in
// JSON mode. Do not change the response writer used by other routes.
type mcpResponseWriter struct {
	http.ResponseWriter
	ctx         context.Context
	wroteHeader bool
	timedOut    bool
}

func (w *mcpResponseWriter) WriteHeader(status int) {
	if !w.wroteHeader {
		w.Header().Set("Cache-Control", "no-store")
		w.wroteHeader = true
		if mcpDeadlineExceeded(w.ctx) {
			// SDK completion can race HTTP cancellation. Enforce the deadline
			// before commitment, not only after the SDK handler returns.
			w.timedOut = true
			writePublicError(w.ResponseWriter, http.StatusGatewayTimeout, ErrorCodeServiceUnavailable, "request timed out")
		} else {
			w.ResponseWriter.WriteHeader(status)
		}
	}
}

func (w *mcpResponseWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.timedOut {
		return len(data), nil
	}
	return w.ResponseWriter.Write(data)
}
