package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/internal/telemetry"
)

const mcpTestHost = "morsel.example"

func mcpTestHandler(t *testing.T, repository share.Repository, cfg RouterConfig) http.Handler {
	t.Helper()
	origin, _ := url.Parse("https://" + mcpTestHost + "/")
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	if cfg.MaxRequestBody == 0 {
		cfg.MaxRequestBody = 4096
	}
	if cfg.RequestTimeout == 0 {
		cfg.RequestTimeout = time.Second
	}
	service := NewService(repository, share.TokenGenerator{}, origin, 100, cfg.Logger)
	cfg.MCP = NewMCPHandler(service, cfg.Authenticator, cfg.MaxRequestBody)
	cfg.Viewer = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "viewer HTML") })
	return NewRouter(service, cfg)
}

func mcpTestRequest(t *testing.T, handler http.Handler, method, body string, change func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "https://"+mcpTestHost+"/mcp", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testAPIKey)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("MCP-Protocol-Version", "2025-11-25")
	if change != nil {
		change(r)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" ||
		w.Header().Get("Content-Security-Policy") != telemetry.ContentSecurityPolicy || w.Header().Get("X-Request-ID") == "" ||
		w.Header().Get("Access-Control-Allow-Origin") != "" || w.Header().Get("X-Morsel-Account-ID") != "" ||
		w.Header().Get("Mcp-Session-Id") != "" {
		t.Fatalf("MCP response headers: %v", w.Header())
	}
	return w
}

type mcpTestResult struct {
	IsError    bool            `json:"isError"`
	Structured json.RawMessage `json:"structuredContent"`
	Content    []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func mcpTestToolBody(name, arguments string) string {
	quoted, _ := json.Marshal(name)
	return `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":` + string(quoted) + `,"arguments":` + arguments + `}}`
}

func mcpTestCall(t *testing.T, handler http.Handler, name, arguments string) mcpTestResult {
	t.Helper()
	w := mcpTestRequest(t, handler, "POST", mcpTestToolBody(name, arguments), nil)
	var envelope struct {
		Result mcpTestResult `json:"result"`
		Error  any           `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil || w.Code != 200 || envelope.Error != nil {
		t.Fatalf("tool response: status=%d body=%s err=%v", w.Code, w.Body.String(), err)
	}
	result := envelope.Result
	if len(result.Content) != 1 || result.Content[0].Type != "text" || !json.Valid(result.Structured) ||
		result.Content[0].Text != string(result.Structured) {
		t.Fatalf("structured/text result disagreement: %+v", result)
	}
	return result
}

func mcpTestError(t *testing.T, result mcpTestResult, code ErrorCode) {
	t.Helper()
	var failure Error
	if err := json.Unmarshal(result.Structured, &failure); err != nil || !result.IsError || failure.Code != code || failure.Message == "" {
		t.Fatalf("tool error: %+v decoded=%+v err=%v", result, failure, err)
	}
}

type mcpRoundTripFunc func(*http.Request) (*http.Response, error)

func (f mcpRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestMCPStreamableSDKClient(t *testing.T) {
	for _, version := range []string{"", "2025-11-25", "2025-06-18", "2025-03-26"} {
		name := version
		if name == "" {
			name = "SDK default"
		}
		t.Run(name, func(t *testing.T) {
			repository := &repositoryStub{revokeFound: true, consumeResult: share.Share{
				ID: uuid.New(), Content: "# Retrieved", CreatedAt: time.Now().UTC(), ViewCount: 1,
			}}
			handler := mcpTestHandler(t, repository, RouterConfig{Authenticator: authenticatorStub{}})
			server := httptest.NewServer(handler)
			defer server.Close()
			clientHTTP := &http.Client{Transport: mcpRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				request := r.Clone(r.Context())
				request.Host = mcpTestHost
				request.Header.Set("Authorization", "Bearer "+testAPIKey)
				return server.Client().Transport.RoundTrip(request)
			})}
			client := mcp.NewClient(&mcp.Implementation{Name: "fixture", Version: "test"}, &mcp.ClientOptions{Capabilities: &mcp.ClientCapabilities{}})
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			// The current SDK first tries discovery for the newer protocol and must
			// successfully fall back to the advertised 2025 initialization protocol.
			session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: clientHTTP, MaxRetries: -1}, &mcp.ClientSessionOptions{ProtocolVersion: version})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			if err := session.Ping(ctx, nil); err != nil {
				t.Fatal(err)
			}
			tools, err := session.ListTools(ctx, nil)
			if err != nil || len(tools.Tools) != 3 {
				t.Fatalf("tools=%+v err=%v", tools, err)
			}
			for _, tool := range tools.Tools {
				if tool.InputSchema == nil || tool.OutputSchema == nil || tool.Annotations == nil || tool.Annotations.ReadOnlyHint ||
					tool.Annotations.IdempotentHint != (tool.Name == "revoke_share") || tool.Annotations.DestructiveHint == nil ||
					*tool.Annotations.DestructiveHint != (tool.Name != "create_share") {
					t.Fatalf("tool contract: %+v", tool)
				}
				compileMCPSchema(tool.InputSchema)
				compileMCPSchema(tool.OutputSchema)
			}
			created, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "create_share", Arguments: map[string]any{"content": "# Hello"}})
			if err != nil || created.IsError || len(repository.created) != 1 || repository.created[0].AccountID != testAccountID {
				t.Fatalf("creation=%+v repository=%+v err=%v", created, repository.created, err)
			}
			for _, call := range []struct {
				name string
				args map[string]any
			}{
				{"get_share", map[string]any{"token": repository.created[0].LinkToken}},
				{"revoke_share", map[string]any{"id": repository.created[0].ID.String()}},
			} {
				result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: call.name, Arguments: call.args})
				if err != nil || result.IsError {
					t.Fatalf("%s: result=%+v err=%v", call.name, result, err)
				}
			}
		})
	}
}

func TestMCPProtocol(t *testing.T) {
	handler := mcpTestHandler(t, &repositoryStub{}, RouterConfig{Authenticator: authenticatorStub{}})
	for _, version := range []string{"2025-11-25", "2025-06-18", "2025-03-26", "1999-01-01"} {
		t.Run(version, func(t *testing.T) {
			body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"` + version + `","capabilities":{},"clientInfo":{"name":"fixture","version":"test"}}}`
			w := mcpTestRequest(t, handler, "POST", body, func(r *http.Request) { r.Header.Del("MCP-Protocol-Version") })
			var response struct {
				Result struct {
					ProtocolVersion string         `json:"protocolVersion"`
					Capabilities    map[string]any `json:"capabilities"`
					ServerInfo      map[string]any `json:"serverInfo"`
				} `json:"result"`
			}
			expected := version
			if version == "1999-01-01" {
				expected = "2025-11-25"
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 ||
				response.Result.ProtocolVersion != expected || len(response.Result.Capabilities) != 1 || response.Result.Capabilities["tools"] == nil ||
				response.Result.ServerInfo["name"] != "morsel" {
				t.Fatalf("initialize: %d %s err=%v", w.Code, w.Body.String(), err)
			}
		})
	}
	w := mcpTestRequest(t, handler, "POST", `{"jsonrpc":"2.0","method":"notifications/initialized"}`, nil)
	if w.Code != 202 || w.Body.Len() != 0 {
		t.Fatalf("notification: %d %s", w.Code, w.Body.String())
	}
	for _, method := range []string{"GET", "DELETE", "HEAD", "OPTIONS"} {
		w := mcpTestRequest(t, handler, method, "", nil)
		if w.Code != 405 || w.Header().Get("Allow") != "POST" || strings.Contains(w.Body.String(), "viewer") {
			t.Fatalf("%s: %d %v %s", method, w.Code, w.Header(), w.Body.String())
		}
	}
	// The SDK rejects unregistered legacy methods at its HTTP validation layer.
	w = mcpTestRequest(t, handler, "POST", `{"jsonrpc":"2.0","id":1,"method":"unknown/method","params":{}}`, nil)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "unsupported") {
		t.Fatalf("unknown method: %d %s", w.Code, w.Body.String())
	}
	for _, method := range []string{"resources/list", "prompts/list", "subscriptions/listen"} {
		w := mcpTestRequest(t, handler, "POST", `{"jsonrpc":"2.0","id":1,"method":"`+method+`","params":{}}`, nil)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `-32601`) {
			t.Fatalf("unsupported %s: %d %s", method, w.Code, w.Body.String())
		}
	}
	// Unknown MCP subpaths must not become successful viewer navigation.
	w = request(t, handler, "GET", "/mcp/unknown", "", "")
	if w.Code != 404 || strings.Contains(w.Body.String(), "viewer") {
		t.Fatalf("subpath: %d %s", w.Code, w.Body.String())
	}
}

func TestMCPTransportFailures(t *testing.T) {
	handler := mcpTestHandler(t, &repositoryStub{}, RouterConfig{Authenticator: authenticatorStub{}})
	for _, test := range []struct {
		name, body string
		change     func(*http.Request)
		status     int
	}{
		{"empty", "", nil, 400},
		{"malformed", "{", nil, 400},
		{"null", "null", nil, 400},
		{"empty batch", "[]", nil, 400},
		{"invalid JSON-RPC", `{"jsonrpc":"1.0","id":1,"method":"ping"}`, nil, 400},
		{"missing tool params", `{"jsonrpc":"2.0","id":1,"method":"tools/call"}`, nil, 400},
		{"tool notification cannot write", `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"create_share","arguments":{"content":"must not exist"}}}`, nil, 400},
		{"notification cannot have id", `{"jsonrpc":"2.0","id":1,"method":"notifications/initialized"}`, nil, 400},
		{"new protocol batch", `[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]`, nil, 400},
		{"unsupported version", `{"jsonrpc":"2.0","id":1,"method":"ping"}`, func(r *http.Request) { r.Header.Set("MCP-Protocol-Version", "1999-01-01") }, 400},
		{"wrong media", `{}`, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{"missing media", `{}`, func(r *http.Request) { r.Header.Del("Content-Type") }, 415},
		{"JSON Accept only", `{}`, func(r *http.Request) { r.Header.Set("Accept", "application/json") }, 400},
		{"SSE Accept only", `{}`, func(r *http.Request) { r.Header.Set("Accept", "text/event-stream") }, 400},
		{"missing Accept", `{}`, func(r *http.Request) { r.Header.Del("Accept") }, 400},
		{"body limit", strings.Repeat(" ", 4097), nil, 413},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := mcpTestRequest(t, handler, "POST", test.body, test.change)
			if w.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", w.Code, test.status, w.Body.String())
			}
		})
	}
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":null}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"missing","arguments":{}}}`,
	} {
		w := mcpTestRequest(t, handler, "POST", body, nil)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"error"`) || strings.Contains(w.Body.String(), `"result"`) {
			t.Fatalf("invalid tool request: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestMCPAuthentication(t *testing.T) {
	for _, test := range []struct {
		name   string
		auth   BearerAuthenticator
		header string
		status int
	}{
		{"missing", authenticatorStub{}, "", 401},
		{"invalid", authenticatorStub{}, "Bearer invalid", 401},
		{"no authenticator", nil, "Bearer " + testAPIKey, 401},
		{"database failure", authenticatorStub{err: errors.New("private auth database failure")}, "Bearer " + testAPIKey, 503},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &repositoryStub{}
			handler := mcpTestHandler(t, repository, RouterConfig{Authenticator: test.auth})
			for _, method := range []string{"POST", "GET", "DELETE"} {
				for _, body := range []string{`{"jsonrpc":"2.0","id":1,"method":"initialize"}`, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, mcpTestToolBody("create_share", `{"content":"private"}`)} {
					w := mcpTestRequest(t, handler, method, body, func(r *http.Request) {
						r.Header.Set("Authorization", test.header)
						r.AddCookie(&http.Cookie{Name: "morsel_session", Value: "browser-session"})
					})
					if w.Code != test.status || strings.Contains(w.Body.String(), "private") || len(repository.created) != 0 ||
						(test.status == 401 && w.Header().Get("WWW-Authenticate") != `Bearer realm="morsel"`) {
						t.Fatalf("%s: %d %v %s", method, w.Code, w.Header(), w.Body.String())
					}
				}
			}
		})
	}
}

func TestMCPOriginAndHost(t *testing.T) {
	handler := mcpTestHandler(t, &repositoryStub{}, RouterConfig{Authenticator: authenticatorStub{}})
	for _, test := range []struct {
		name    string
		origins []string
		status  int
	}{
		{"omitted", nil, 200}, {"exact", []string{"https://morsel.example"}, 200},
		{"foreign", []string{"https://attacker.example"}, 403}, {"null", []string{"null"}, 403},
		{"empty", []string{""}, 403}, {"slash", []string{"https://morsel.example/"}, 403},
		{"default port not canonical", []string{"https://morsel.example:443"}, 403},
		{"duplicate", []string{"https://morsel.example", "https://morsel.example"}, 403},
		{"mixed", []string{"https://morsel.example", "https://attacker.example"}, 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := mcpTestRequest(t, handler, "POST", `{"jsonrpc":"2.0","id":1,"method":"ping"}`, func(r *http.Request) {
				for _, origin := range test.origins {
					r.Header.Add("Origin", origin)
				}
			})
			if w.Code != test.status {
				t.Fatalf("origin: %d %s", w.Code, w.Body.String())
			}
		})
	}
	for _, host := range []string{"morsel.example", "MORSEL.EXAMPLE", "morsel.example:443", "attacker.example", "morsel.example.attacker.example", "morsel.example:8443", "morsel.example:", "morsel.example#", "morsel.example?", "user@morsel.example", ""} {
		w := mcpTestRequest(t, handler, "POST", `{"jsonrpc":"2.0","id":1,"method":"ping"}`, func(r *http.Request) {
			r.Host = host
			r.Header.Set("X-Forwarded-Host", mcpTestHost)
			r.Header.Set("Forwarded", `host="`+mcpTestHost+`";proto=https`)
		})
		want := 403
		if host == "morsel.example" || host == "MORSEL.EXAMPLE" || host == "morsel.example:443" {
			want = 200
		}
		if w.Code != want {
			t.Fatalf("host=%q: status=%d want=%d body=%s", host, w.Code, want, w.Body.String())
		}
	}
}

func TestMCPPublishedIntegerBounds(t *testing.T) {
	handler := mcpTestHandler(t, &repositoryStub{}, RouterConfig{Authenticator: authenticatorStub{}})
	w := mcpTestRequest(t, handler, "POST", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, nil)
	if w.Code != 200 || strings.Count(w.Body.String(), `"maximum":9223372036854775807`) != 3 {
		t.Fatalf("published schemas rounded int64 bounds: %d %s", w.Code, w.Body.String())
	}
}

func TestMCPToolValidation(t *testing.T) {
	for _, arguments := range []string{
		`{}`, `null`, `[]`, `{"content":null}`, `{"content":1}`, `{"content":"ok","account_id":"forged"}`, `{"content":"ok","owner":"forged"}`,
		`{"content":"ok","expires_in":0}`, `{"content":"ok","expires_in":315360001}`, `{"content":"ok","max_views":0}`,
		`{"content":"ok","max_views":1.5}`, `{"content":"ok","max_views":9223372036854775808}`, `{"content":"ok","max_views":"2"}`,
		`{"content":"ok","max_views":1e1000000000}`, `{"content":"ok","owner":1e1000000000}`, `{"content":"ok","expires_in":1e-1000000000}`,
		`{"content":"NUL\u0000"}`, `{"content":"ok","preview":null}`, `{"content":"ok","preview":[]}`, `{"content":"ok","preview":{"title":"Title"}}`,
		`{"content":"ok","preview":{"title":"Title","description":"Description","unknown":"value"}}`,
		`{"content":"ok","preview":{"title":"Title","description":"Description","image":null}}`,
		`{"content":"ok","preview":{"title":"Title","description":"Description","locale":null}}`,
		`{"content":"ok","preview":{"title":" ","description":"Description"}}`,
		`{"content":"ok","preview":{"title":"Title\nline","description":"Description"}}`,
		`{"content":"ok","preview":{"title":"Title","description":"Description","image":"https://user:secret@example.com/image"}}`,
		`{"content":"ok","preview":{"title":"Title","description":"Description","locale":"zh-tw"}}`,
		`{"content":"ok","telegram_instant_view":null}`, `{"content":"ok","telegram_instant_view":"true"}`, `{"content":"ok","telegram_instant_view":true}`,
		`{"content":"ok","preview":{"title":"Title","description":"Description"},"telegram_instant_view":true,"max_views":1}`,
		`{"content":"ok","preview":{"title":"Title","description":"Description"},"telegram_instant_view":true,"expires_in":1}`,
	} {
		t.Run(arguments, func(t *testing.T) {
			repository := &repositoryStub{}
			handler := mcpTestHandler(t, repository, RouterConfig{Authenticator: authenticatorStub{}})
			mcpTestError(t, mcpTestCall(t, handler, "create_share", arguments), ErrorCodeInvalidRequest)
			if len(repository.created) != 0 {
				t.Fatal("invalid arguments reached repository")
			}
		})
	}
	repository := &repositoryStub{}
	handler := mcpTestHandler(t, repository, RouterConfig{Authenticator: authenticatorStub{}})
	mcpTestError(t, mcpTestCall(t, handler, "create_share", `{"content":"`+strings.Repeat("x", 101)+`"}`), ErrorCodeContentTooLarge)
	for _, call := range []struct{ tool, arguments string }{
		{"get_share", `{}`}, {"get_share", `{"token":null}`}, {"get_share", `{"token":123}`}, {"get_share", `{"token":"https://example.com/share"}`},
		{"get_share", `{"token":"` + uuid.NewString() + `"}`}, {"get_share", `{"token":"abc","account_id":"forged"}`},
		{"revoke_share", `{}`}, {"revoke_share", `{"id":null}`}, {"revoke_share", `{"id":"not-a-uuid"}`},
		{"revoke_share", `{"id":"` + strings.Repeat("a", 43) + `"}`}, {"revoke_share", `{"id":"` + uuid.NewString() + `","owner":"forged"}`},
	} {
		mcpTestError(t, mcpTestCall(t, handler, call.tool, call.arguments), ErrorCodeInvalidRequest)
	}
	for _, arguments := range []string{
		`{"content":""}`, `{"content":"# Hello","max_views":null,"expires_in":null,"telegram_instant_view":false}`,
		`{"content":"ok","preview":{"title":"  Title  ","description":" Description ","image":" https://example.com/image ","locale":" zh_TW "},"telegram_instant_view":true,"expires_in":null,"max_views":null}`,
		`{"content":"ok","preview":{"title":"` + strings.Repeat(" ", 90) + `Title` + strings.Repeat(" ", 90) + `","description":"Description"}}`,
	} {
		result := mcpTestCall(t, handler, "create_share", arguments)
		if result.IsError {
			t.Fatalf("valid create failed: %s", result.Structured)
		}
	}
	if repository.created[2].Preview.Title != "Title" || repository.created[2].Preview.Image != "https://example.com/image" || !repository.created[2].TelegramInstantView {
		t.Fatalf("preview normalization changed: %+v", repository.created[2])
	}
}

func TestMCPToolErrorsAndSecretFreeLogs(t *testing.T) {
	var logs bytes.Buffer
	repository := &repositoryStub{}
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := mcpTestHandler(t, repository, RouterConfig{Authenticator: authenticatorStub{}, Logger: logger})
	result := mcpTestCall(t, handler, "create_share", `{"content":"private Markdown fixture"}`)
	var created CreateShareResponse
	if err := json.Unmarshal(result.Structured, &created); err != nil || result.IsError {
		t.Fatalf("creation=%s err=%v", result.Structured, err)
	}
	token := repository.created[0].LinkToken
	for _, test := range []struct {
		err  error
		code ErrorCode
	}{
		{share.ErrNotFound, ErrorCodeNotFound}, {share.ErrExpired, ErrorCodeExpired}, {share.ErrRevoked, ErrorCodeRevoked},
		{share.ErrViewLimitExhausted, ErrorCodeViewLimitExhausted}, {errors.New("database unavailable"), ErrorCodeInternalError},
	} {
		repository.consumeError = test.err
		mcpTestError(t, mcpTestCall(t, handler, "get_share", `{"token":"`+token+`"}`), test.code)
	}
	repository.createErrors = []error{nil, errors.New("database unavailable")}
	mcpTestError(t, mcpTestCall(t, handler, "create_share", `{"content":"private Markdown fixture"}`), ErrorCodeInternalError)
	repository.revokeFound = false
	mcpTestError(t, mcpTestCall(t, handler, "revoke_share", `{"id":"`+created.Id.String()+`"}`), ErrorCodeNotFound)
	repository.revokeError = errors.New("database unavailable")
	mcpTestError(t, mcpTestCall(t, handler, "revoke_share", `{"id":"`+created.Id.String()+`"}`), ErrorCodeInternalError)
	_ = mcpTestRequest(t, handler, "POST", mcpTestToolBody("create_share", `{"content":"private Markdown fixture","unknown":"private payload fixture"}`), func(r *http.Request) {
		r.URL.RawQuery = "secret=" + token
	})
	for _, secret := range []string{testAPIKey, token, created.ShareUrl, "private Markdown fixture", "private payload fixture", `"arguments"`, "secret="} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("secret in logs: %s", logs.String())
		}
	}
	if !strings.Contains(logs.String(), `"route":"/mcp"`) {
		t.Fatalf("missing bounded route: %s", logs.String())
	}
}
