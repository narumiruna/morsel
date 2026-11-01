package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/internal/telemetry"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
)

type mcpContextRepository struct {
	share.Repository
	started  chan context.Context
	finished chan struct{}
}

func (r *mcpContextRepository) wait(ctx context.Context) error {
	r.started <- ctx
	<-ctx.Done()
	close(r.finished)
	return ctx.Err()
}

func (r *mcpContextRepository) Create(ctx context.Context, _ share.CreateParams) (share.Share, error) {
	return share.Share{}, r.wait(ctx)
}

func (r *mcpContextRepository) Consume(ctx context.Context, _ [32]byte) (share.Share, error) {
	return share.Share{}, r.wait(ctx)
}

func (r *mcpContextRepository) Revoke(ctx context.Context, _, _ uuid.UUID) (bool, error) {
	return false, r.wait(ctx)
}

func TestMCPRequestLifetime(t *testing.T) {
	for _, call := range []struct{ tool, arguments string }{
		{"create_share", `{"content":"deadline fixture"}`},
		{"get_share", `{"token":"` + strings.Repeat("A", 43) + `"}`},
		{"revoke_share", `{"id":"` + uuid.NewString() + `"}`},
	} {
		for _, lifetime := range []string{"deadline", "disconnect"} {
			t.Run(call.tool+"/"+lifetime, func(t *testing.T) {
				repository := &mcpContextRepository{Repository: &repositoryStub{}, started: make(chan context.Context, 1), finished: make(chan struct{})}
				timeout := time.Second
				if lifetime == "deadline" {
					timeout = 50 * time.Millisecond
				}
				handler := mcpTestHandler(t, repository, RouterConfig{Authenticator: authenticatorStub{}, RequestTimeout: timeout})
				body := mcpTestToolBody(call.tool, call.arguments)
				if lifetime == "deadline" {
					start := time.Now()
					w := mcpTestRequest(t, handler, "POST", body, nil)
					if w.Code != 504 || !strings.Contains(w.Body.String(), "request timed out") || time.Since(start) > time.Second {
						t.Fatalf("deadline response: %d %s after %s", w.Code, w.Body.String(), time.Since(start))
					}
				} else {
					returned := make(chan struct{})
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						defer close(returned)
						handler.ServeHTTP(w, r)
					}))
					defer server.Close()
					ctx, cancel := context.WithCancel(t.Context())
					defer cancel()
					r, err := http.NewRequestWithContext(ctx, "POST", server.URL+"/mcp", strings.NewReader(body))
					if err != nil {
						t.Fatal(err)
					}
					r.Host = mcpTestHost
					r.Header.Set("Authorization", "Bearer "+testAPIKey)
					r.Header.Set("Content-Type", "application/json")
					r.Header.Set("Accept", "application/json, text/event-stream")
					clientDone := make(chan error, 1)
					go func() {
						response, err := server.Client().Do(r)
						if response != nil {
							response.Body.Close()
						}
						clientDone <- err
					}()
					select {
					case operation := <-repository.started:
						repository.started <- operation
					case <-time.After(time.Second):
						t.Fatal("operation did not start")
					}
					cancel()
					if err := <-clientDone; !errors.Is(err, context.Canceled) {
						t.Fatalf("client cancellation: %v", err)
					}
					select {
					case <-returned:
					case <-time.After(time.Second):
						t.Fatal("canceled HTTP handler did not return")
					}
				}
				select {
				case <-repository.finished:
				default:
					t.Fatal("HTTP request returned before the operation stopped")
				}
				operation := <-repository.started
				if _, ok := operation.Deadline(); !ok || operation.Err() == nil || authorizedAccount(operation) != testAccountID || telemetry.Info(operation) == nil {
					t.Fatal("operation lost its HTTP deadline, cancellation, principal, or request metadata")
				}
			})
		}
	}
}

// Model a deadline whose timer callback has not run yet: Err is still nil.
type mcpPendingDeadlineContext struct {
	context.Context
	deadline time.Time
}

func (c mcpPendingDeadlineContext) Deadline() (time.Time, bool) { return c.deadline, true }

func TestMCPResponseCommitDeadline(t *testing.T) {
	for _, timerPending := range []bool{false, true} {
		for _, explicit := range []bool{false, true} {
			t.Run("pending="+strconv.FormatBool(timerPending)+"/explicit="+strconv.FormatBool(explicit), func(t *testing.T) {
				expired, cancel := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
				defer cancel()
				var ctx context.Context = expired
				if timerPending {
					ctx = mcpPendingDeadlineContext{Context: t.Context(), deadline: time.Now().Add(-time.Second)}
					if ctx.Err() != nil {
						t.Fatal("pending deadline timer must not have set Err")
					}
				}
				response := httptest.NewRecorder()
				writer := &mcpResponseWriter{ResponseWriter: response, ctx: ctx}
				writer.Header().Set("Cache-Control", "no-cache, no-transform")
				if explicit {
					writer.WriteHeader(http.StatusOK)
				}
				for range 2 {
					if n, err := writer.Write([]byte("late SDK payload")); n != len("late SDK payload") || err != nil {
						t.Fatalf("discarded write: %d %v", n, err)
					}
				}
				var failure Error
				if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || response.Code != 504 ||
					failure.Code != ErrorCodeServiceUnavailable || failure.Message != "request timed out" ||
					response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Type") != "application/json" {
					t.Fatalf("late commitment: %d %v %s err=%v", response.Code, response.Header(), response.Body.String(), err)
				}
			})
		}
	}
	t.Run("already committed", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
		defer cancel()
		response := httptest.NewRecorder()
		writer := &mcpResponseWriter{ResponseWriter: response, ctx: ctx}
		writer.WriteHeader(http.StatusOK)
		<-ctx.Done()
		_, _ = writer.Write([]byte("committed response"))
		if response.Code != 200 || response.Body.String() != "committed response" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("committed response was rewritten: %d %s", response.Code, response.Body.String())
		}
	})
}

func TestMCPReverseProxyConfiguredAuthority(t *testing.T) {
	backend := httptest.NewServer(mcpTestHandler(t, &repositoryStub{}, RouterConfig{Authenticator: authenticatorStub{}}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	proxy := httptest.NewServer(httputil.NewSingleHostReverseProxy(target))
	defer proxy.Close()
	for _, host := range []string{mcpTestHost, "attacker.example"} {
		r, err := http.NewRequestWithContext(t.Context(), "POST", proxy.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		if err != nil {
			t.Fatal(err)
		}
		r.Host = host
		r.Header.Set("Origin", "https://"+mcpTestHost)
		r.Header.Set("X-Forwarded-Host", mcpTestHost)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		r.Header.Set("Authorization", "Bearer "+testAPIKey)
		response, err := proxy.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		want := 403
		if host == mcpTestHost {
			want = 200
		}
		if response.StatusCode != want || response.Header.Get("Cache-Control") != "no-store" || (want == 200 && !json.Valid(body)) {
			t.Fatalf("proxy Host=%q: %d %v %s", host, response.StatusCode, response.Header, body)
		}
	}
}

func TestMCPCanonicalAuthority(t *testing.T) {
	for _, test := range []struct{ scheme, authority, want string }{
		{"https", "MORSEL.EXAMPLE:443", "morsel.example"}, {"http", "LOCALHOST:80", "localhost"},
		{"http", "localhost:5173", "localhost:5173"}, {"https", "morsel.example:8443", "morsel.example:8443"},
		{"https", "[::1]:443", "[::1]"}, {"http", "[::1]:5173", "[::1]:5173"},
		{"https", "morsel.example:0", ""}, {"https", "morsel.example:65536", ""}, {"https", "morsel.example:bad", ""},
		{"https", "morsel.example#", ""}, {"https", "morsel.example?", ""}, {"https", "morsel.example/path", ""},
		{"https", "user@morsel.example", ""}, {"https", "[::1", ""},
	} {
		if got := canonicalMCPAuthority(test.scheme, test.authority); got != test.want {
			t.Fatalf("%s %q: got %q want %q", test.scheme, test.authority, got, test.want)
		}
	}
}

func TestMCPMiddlewareFailsClosedWithoutHTTPPrincipal(t *testing.T) {
	called := false
	handler := mcpRequestContext(func(context.Context, string, mcp.Request) (mcp.Result, error) {
		called = true
		return nil, nil
	})
	if _, err := handler(t.Context(), "tools/list", nil); err == nil || called {
		t.Fatal("missing HTTP principal reached the tool server")
	}
}

func TestMCPPostgresLegacyBatch(t *testing.T) {
	f := mcpDBOpen(t)
	var batch []any
	for n := range 16 {
		batch = append(batch, map[string]any{
			"jsonrpc": "2.0", "id": n, "method": "tools/call",
			"params": map[string]any{"name": "create_share", "arguments": map[string]any{"content": "batch " + strconv.Itoa(n)}},
		})
	}
	response := f.do(t, f.accounts[0].keys[0], "POST", "/mcp", mcpDBJSON(batch), http.Header{"Mcp-Protocol-Version": {"2025-03-26"}})
	mcpDBStatus(t, response, 200)
	var results []struct {
		ID     int         `json:"id"`
		Result mcpDBResult `json:"result"`
	}
	mcpDBUnmarshal(t, response.body, &results)
	seen := make(map[int]bool)
	for _, result := range results {
		if seen[result.ID] {
			t.Fatal("duplicate batch response")
		}
		seen[result.ID] = true
		mcpDBSuccess(t, result.Result, nil)
	}
	if len(results) != 16 || testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE account_id=$1`, f.accounts[0].id) != 16 {
		t.Fatal("legacy batch lost or duplicated a creation")
	}
}
