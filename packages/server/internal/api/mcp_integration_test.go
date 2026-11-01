package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/internal/auth"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
	"github.com/narumiruna/morsel/packages/server/internal/viewer"
)

func TestMCPPostgresOwnershipAndKeys(t *testing.T) {
	f := mcpDBOpen(t)
	a, b := f.accounts[0], f.accounts[1]
	headers := http.Header{"X-Morsel-Account-ID": {b.id.String()}, "Mcp-Session-Id": {uuid.NewString()}}
	// Neither a query nor a header selects the account that owns a new share.
	response := f.do(t, a.keys[0], http.MethodPost, "/mcp?account_id="+b.id.String(),
		mcpDBPayload("create_share", map[string]any{"content": "owned by A"}), headers)
	result := mcpDBDecode(t, response)
	var owned CreateShareResponse
	mcpDBSuccess(t, result, &owned)
	mcpDBOwner(t, f, owned.Id, a.id)
	foreign := f.create(t, b.keys[0], map[string]any{"content": "owned by B"})

	before := testdb.Count(t, f.pool, `SELECT count(*) FROM shares`)
	for _, field := range []string{"account", "account_id", "owner", "owner_id"} {
		for _, tool := range []struct {
			name, field, value string
		}{
			{"create_share", "content", "forged owner"},
			{"get_share", "token", mcpDBToken(t, foreign)},
			{"revoke_share", "id", owned.Id.String()},
		} {
			t.Run(tool.name+"/"+field, func(t *testing.T) {
				mcpDBError(t, f.call(t, a.keys[0], tool.name, map[string]any{
					tool.field: tool.value, field: b.id.String(),
				}, headers), ErrorCodeInvalidRequest)
			})
		}
	}
	if got := testdb.Count(t, f.pool, `SELECT count(*) FROM shares`); got != before {
		t.Fatal("rejected arguments created a share")
	}
	if got := testdb.Count(t, f.pool, `SELECT sum(view_count) FROM shares`); got != 0 {
		t.Fatal("rejected arguments consumed a view")
	}
	if got := testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE revoked_at IS NOT NULL`); got != 0 {
		t.Fatal("rejected arguments revoked a share")
	}

	foreignResult := f.call(t, a.keys[0], "revoke_share", map[string]any{"id": foreign.Id}, headers)
	missingResult := f.call(t, a.keys[1], "revoke_share", map[string]any{"id": uuid.New()}, headers)
	mcpDBError(t, foreignResult, ErrorCodeNotFound)
	mcpDBError(t, missingResult, ErrorCodeNotFound)
	if !bytes.Equal(foreignResult.Structured, missingResult.Structured) {
		t.Fatal("foreign and missing revocations disclose different results")
	}
	// Both keys for A can revoke the share created by A's first key.
	for _, key := range []string{a.keys[1], a.keys[0], a.keys[1]} {
		var revoked struct {
			ID      uuid.UUID `json:"id"`
			Revoked bool      `json:"revoked"`
		}
		mcpDBSuccess(t, f.call(t, key, "revoke_share", map[string]any{"id": owned.Id}, headers), &revoked)
		if revoked.ID != owned.Id || !revoked.Revoked {
			t.Fatal("invalid owned revocation result")
		}
	}
	if got := testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE id=$1 AND revoked_at IS NULL`, foreign.Id); got != 1 {
		t.Fatal("foreign revocation changed the share")
	}

	// Reuse the same session header across keys, then revoke a key between calls.
	f.createWithHeaders(t, a.keys[0], map[string]any{"content": "before key revocation"}, headers)
	hash := sha256.Sum256([]byte(a.keys[0]))
	if _, err := f.pool.Exec(t.Context(), `UPDATE api_keys SET revoked_at=clock_timestamp() WHERE token_hash=$1`, hash[:]); err != nil {
		t.Fatal(err)
	}
	before = testdb.Count(t, f.pool, `SELECT count(*) FROM shares`)
	for _, session := range []string{headers.Get("Mcp-Session-Id"), uuid.NewString()} {
		for _, key := range []string{a.keys[0], uuid.NewString(), ""} {
			r := f.do(t, key, http.MethodPost, "/mcp", mcpDBPayload("create_share", map[string]any{"content": "must not exist"}),
				http.Header{"Mcp-Session-Id": {session}, "X-Morsel-Account-ID": {b.id.String()}})
			mcpDBStatus(t, r, http.StatusUnauthorized)
			if r.header.Get("WWW-Authenticate") != `Bearer realm="morsel"` {
				t.Fatal("missing Bearer challenge")
			}
		}
	}
	if got := testdb.Count(t, f.pool, `SELECT count(*) FROM shares`); got != before {
		t.Fatal("revoked or invalid key executed a tool")
	}
	for _, person := range []mcpDBAccount{a, b} {
		created := f.createWithHeaders(t, person.keys[1], map[string]any{"content": "active key"}, headers)
		mcpDBOwner(t, f, created.Id, person.id)
	}
}

func TestMCPPostgresConcurrentAccountIsolation(t *testing.T) {
	f := mcpDBOpen(t)
	seeds := [2]CreateShareResponse{}
	for i, person := range f.accounts {
		seeds[i] = f.create(t, person.keys[0], map[string]any{"content": fmt.Sprintf("account %d capability", i)})
	}
	// Cleanup runs after the parallel subtests and verifies exact shared state.
	t.Cleanup(func() {
		for _, seed := range seeds {
			mcpDBViews(t, f, seed.Id, 8)
			if got := testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE id=$1 AND revoked_at IS NULL`, seed.Id); got != 1 {
				t.Error("a concurrent foreign revocation changed a seed share")
			}
		}
	})
	// Every request uses the same forged session value, including across accounts.
	session := uuid.NewString()
	for n := range 16 {
		t.Run(strconv.Itoa(n), func(t *testing.T) {
			t.Parallel()
			index := n % 2
			person, other := f.accounts[index], f.accounts[1-index]
			headers := http.Header{"Mcp-Session-Id": {session}, "X-Morsel-Account-ID": {other.id.String()}}
			created := f.createWithHeaders(t, person.keys[n%2], map[string]any{"content": fmt.Sprintf("request %d", n)}, headers)
			mcpDBOwner(t, f, created.Id, person.id)
			mcpDBError(t, f.call(t, person.keys[0], "revoke_share", map[string]any{"id": seeds[1-index].Id}, headers), ErrorCodeNotFound)
			var read Share
			mcpDBSuccess(t, f.call(t, person.keys[1], "get_share", map[string]any{"token": mcpDBToken(t, seeds[1-index])}, headers), &read)
			if read.Content != fmt.Sprintf("account %d capability", 1-index) {
				t.Fatal("wrong capability content")
			}
			mcpDBSuccess(t, f.call(t, person.keys[1-n%2], "revoke_share", map[string]any{"id": created.Id}, headers), nil)
			if got := testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE id=$1 AND account_id=$2 AND revoked_at IS NOT NULL`, created.Id, person.id); got != 1 {
				t.Fatal("concurrent call lost its account context")
			}
		})
	}
}

func TestMCPPostgresRESTInteroperabilityAndPreview(t *testing.T) {
	for _, source := range []string{"REST", "MCP"} {
		t.Run(source, func(t *testing.T) {
			f := mcpDBOpen(t)
			a, b := f.accounts[0], f.accounts[1]
			input := map[string]any{
				"content": "# Shared document", "max_views": 3,
				"preview": map[string]any{"title": "Preview title", "description": "Preview description"},
			}
			var created CreateShareResponse
			if source == "REST" {
				r := f.do(t, a.keys[0], http.MethodPost, "/v1/shares", mcpDBJSON(input), nil)
				mcpDBStatus(t, r, http.StatusCreated)
				mcpDBUnmarshal(t, r.body, &created)
			} else {
				created = f.create(t, a.keys[0], input)
			}
			mcpDBOwner(t, f, created.Id, a.id)
			mcpDBViews(t, f, created.Id, 0)
			token := mcpDBToken(t, created)
			for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodGet} {
				r := f.do(t, "", method, "/s/"+token, "", nil)
				mcpDBStatus(t, r, http.StatusOK)
				if method == http.MethodGet && !strings.Contains(string(r.body), `<meta property="og:title" content="Preview title">`) {
					t.Fatal("preview metadata was not fetched")
				}
				mcpDBViews(t, f, created.Id, 0)
			}

			var read Share
			if source == "REST" {
				// A valid foreign capability is readable with B's key, not B's ownership.
				r := f.do(t, b.keys[1], http.MethodPost, "/mcp", mcpDBPayload("get_share", map[string]any{"token": token}), nil)
				mcpDBSuccess(t, mcpDBDecode(t, r), &read)
				mcpDBNoIdentity(t, r, f.accounts)
				mcpDBSuccess(t, f.call(t, a.keys[1], "revoke_share", map[string]any{"id": created.Id}, nil), nil)
			} else {
				r := f.do(t, "", http.MethodGet, "/v1/shares/"+token, "", nil)
				mcpDBStatus(t, r, http.StatusOK)
				mcpDBUnmarshal(t, r.body, &read)
				mcpDBNoIdentity(t, r, f.accounts)
				mcpDBStatus(t, f.do(t, a.keys[1], http.MethodDelete, "/v1/shares/"+created.Id.String(), "", nil), http.StatusNoContent)
			}
			if read.Content != input["content"] || read.ViewCount != 1 || read.ViewsRemaining == nil || *read.ViewsRemaining != 2 {
				t.Fatalf("incorrect consuming result: %+v", read)
			}
			mcpDBViews(t, f, created.Id, 1)
			mcpDBError(t, f.call(t, b.keys[0], "get_share", map[string]any{"token": token}, nil), ErrorCodeRevoked)
			mcpDBViews(t, f, created.Id, 1)
		})
	}
}

func TestMCPPostgresUnavailableCapabilities(t *testing.T) {
	f := mcpDBOpen(t)
	a, b := f.accounts[0], f.accounts[1]
	for _, code := range []ErrorCode{ErrorCodeExpired, ErrorCodeRevoked, ErrorCodeViewLimitExhausted} {
		t.Run(string(code), func(t *testing.T) {
			created := f.create(t, a.keys[0], map[string]any{"content": "unavailable", "max_views": 1})
			token := mcpDBToken(t, created)
			var count int64
			switch code {
			case ErrorCodeExpired:
				// Set fixture time directly; no sleeps or timing-dependent expiration.
				if _, err := f.pool.Exec(t.Context(), `UPDATE shares SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, created.Id); err != nil {
					t.Fatal(err)
				}
			case ErrorCodeRevoked:
				mcpDBSuccess(t, f.call(t, a.keys[1], "revoke_share", map[string]any{"id": created.Id}, nil), nil)
			case ErrorCodeViewLimitExhausted:
				mcpDBStatus(t, f.do(t, "", http.MethodGet, "/v1/shares/"+token, "", nil), http.StatusOK)
				count = 1
			}
			result := f.call(t, b.keys[0], "get_share", map[string]any{"token": token}, nil)
			mcpDBError(t, result, code)
			rest := f.do(t, "", http.MethodGet, "/v1/shares/"+token, "", nil)
			mcpDBStatus(t, rest, http.StatusGone)
			var restError, toolError Error
			mcpDBUnmarshal(t, rest.body, &restError)
			mcpDBUnmarshal(t, result.Structured, &toolError)
			if restError != toolError {
				t.Fatalf("REST/MCP domain error mismatch: %+v / %+v", restError, toolError)
			}
			mcpDBViews(t, f, created.Id, count)
		})
	}
}

func TestMCPPostgresConcurrentFinalViewRESTAndMCP(t *testing.T) {
	f := mcpDBOpen(t)
	created := f.create(t, f.accounts[0].keys[0], map[string]any{"content": "final view", "max_views": 2})
	token := mcpDBToken(t, created)
	// Consume the first view, leaving exactly one for both transports to race for.
	mcpDBStatus(t, f.do(t, "", http.MethodGet, "/v1/shares/"+token, "", nil), http.StatusOK)
	mcpDBViews(t, f, created.Id, 1)
	type outcome struct {
		mcp      bool
		response mcpDBResponse
		err      error
	}
	const callers = 24
	start := make(chan struct{})
	results := make(chan outcome, callers)
	for n := range callers {
		go func() {
			<-start
			isMCP := n%2 == 0
			var response mcpDBResponse
			var err error
			if isMCP {
				response, err = f.request(t.Context(), f.accounts[(n/2)%2].keys[(n/4)%2], http.MethodPost, "/mcp",
					mcpDBPayload("get_share", map[string]any{"token": token}), http.Header{"Mcp-Session-Id": {"forged-shared-session"}})
			} else {
				response, err = f.request(t.Context(), "", http.MethodGet, "/v1/shares/"+token, "", nil)
			}
			results <- outcome{isMCP, response, err}
		}()
	}
	close(start)
	successes := 0
	for range callers {
		result := <-results
		if result.err != nil {
			t.Error(result.err)
			continue
		}
		var read Share
		if result.mcp {
			tool := mcpDBDecode(t, result.response)
			if tool.IsError {
				mcpDBError(t, tool, ErrorCodeViewLimitExhausted)
				continue
			}
			mcpDBSuccess(t, tool, &read)
		} else if result.response.status == http.StatusGone {
			var failure Error
			mcpDBUnmarshal(t, result.response.body, &failure)
			if failure.Code != ErrorCodeViewLimitExhausted {
				t.Fatalf("unexpected REST failure: %+v", failure)
			}
			continue
		} else {
			mcpDBStatus(t, result.response, http.StatusOK)
			mcpDBUnmarshal(t, result.response.body, &read)
		}
		successes++
		if read.Content != "final view" || read.ViewCount != 2 || read.ViewsRemaining == nil || *read.ViewsRemaining != 0 {
			t.Fatalf("incorrect final view: %+v", read)
		}
	}
	if successes != 1 {
		t.Fatalf("final successes=%d, want 1", successes)
	}
	mcpDBViews(t, f, created.Id, 2)
	if got := testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE id=$1 AND view_count>max_views`, created.Id); got != 0 {
		t.Fatal("stored count exceeded max_views")
	}
}

func TestMCPPostgresExactInt64MaxViews(t *testing.T) {
	f := mcpDBOpen(t)
	// Keep request and response numbers as raw JSON, never map[string]float64.
	result := f.call(t, f.accounts[0].keys[0], "create_share",
		json.RawMessage(`{"content":"exact integer","max_views":9223372036854775807}`), nil)
	var created CreateShareResponse
	mcpDBSuccess(t, result, &created)
	mcpDBExactNumber(t, result.Structured, "max_views", math.MaxInt64)
	if created.MaxViews == nil || *created.MaxViews != math.MaxInt64 {
		t.Fatalf("creation rounded max_views: %v", created.MaxViews)
	}
	if got := testdb.Count(t, f.pool, `SELECT max_views FROM shares WHERE id=$1`, created.Id); got != math.MaxInt64 {
		t.Fatalf("stored max_views=%d", got)
	}
	mcpDBViews(t, f, created.Id, 0)
	result = f.call(t, f.accounts[1].keys[1], "get_share", map[string]any{"token": mcpDBToken(t, created)}, nil)
	mcpDBSuccess(t, result, nil)
	mcpDBExactNumber(t, result.Structured, "max_views", math.MaxInt64)
	mcpDBExactNumber(t, result.Structured, "views_remaining", math.MaxInt64-1)
	mcpDBViews(t, f, created.Id, 1)
}

type mcpDBAccount struct {
	id   uuid.UUID
	keys [2]string
}

type mcpDBFixture struct {
	pool     *pgxpool.Pool
	server   *httptest.Server
	origin   *url.URL
	accounts [2]mcpDBAccount
}

type mcpDBResponse struct {
	status int
	header http.Header
	body   []byte
}

type mcpDBResult struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Structured json.RawMessage `json:"structuredContent"`
	IsError    bool            `json:"isError"`
}

func mcpDBOpen(t *testing.T) *mcpDBFixture {
	t.Helper()
	f := &mcpDBFixture{pool: testdb.Open(t)}
	var err error
	f.origin, err = url.Parse("https://morsel.example")
	if err != nil {
		t.Fatal(err)
	}
	authenticator, err := auth.NewService(f.pool, f.origin)
	if err != nil {
		t.Fatal(err)
	}
	for i := range f.accounts {
		person := &f.accounts[i]
		person.id = testdb.Account(t, f.pool)
		for k := range person.keys {
			person.keys[k] = uuid.NewString()
			hash := sha256.Sum256([]byte(person.keys[k]))
			if _, err := f.pool.Exec(t.Context(), `INSERT INTO api_keys(id,account_id,name,prefix,token_hash)
				VALUES($1,$2,'MCP fixture','fixture',$3)`, uuid.New(), person.id, hash[:]); err != nil {
				t.Fatal(err)
			}
		}
	}
	repo := share.NewPostgresRepository(f.pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service := NewService(repo, share.TokenGenerator{}, f.origin, 4096, logger)
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte(`<!doctype html><head></head><body><div id="root"></div></body>`), 0o600); err != nil {
		t.Fatal(err)
	}
	preview, err := viewer.New(directory, repo, f.origin)
	if err != nil {
		t.Fatal(err)
	}
	const maxRequestBytes = 8192
	f.server = httptest.NewServer(NewRouter(service, RouterConfig{
		Authenticator: authenticator, Account: authenticator, Viewer: preview,
		MCP: NewMCPHandler(service, authenticator, maxRequestBytes), Logger: logger,
		MaxRequestBody: maxRequestBytes, RequestTimeout: 10 * time.Second,
	}))
	f.server.Client().Timeout = 15 * time.Second
	t.Cleanup(f.server.Close)
	return f
}

func (f *mcpDBFixture) request(ctx context.Context, key, method, path, body string, headers http.Header) (mcpDBResponse, error) {
	r, err := http.NewRequestWithContext(ctx, method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		return mcpDBResponse{}, err
	}
	// The socket is loopback, but MCP must see the configured public authority.
	r.Host = f.origin.Host
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("MCP-Protocol-Version", "2025-11-25")
	if key != "" {
		r.Header.Set("Authorization", "Bearer "+key)
	}
	for name, values := range headers {
		r.Header[name] = append([]string(nil), values...)
	}
	response, err := f.server.Client().Do(r)
	if err != nil {
		return mcpDBResponse{}, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	return mcpDBResponse{response.StatusCode, response.Header, data}, err
}

func (f *mcpDBFixture) do(t *testing.T, key, method, path, body string, headers http.Header) mcpDBResponse {
	t.Helper()
	response, err := f.request(t.Context(), key, method, path, body, headers)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func (f *mcpDBFixture) call(t *testing.T, key, tool string, arguments any, headers http.Header) mcpDBResult {
	t.Helper()
	return mcpDBDecode(t, f.do(t, key, http.MethodPost, "/mcp", mcpDBPayload(tool, arguments), headers))
}

func (f *mcpDBFixture) create(t *testing.T, key string, arguments any) CreateShareResponse {
	t.Helper()
	return f.createWithHeaders(t, key, arguments, nil)
}

func (f *mcpDBFixture) createWithHeaders(t *testing.T, key string, arguments any, headers http.Header) CreateShareResponse {
	t.Helper()
	var created CreateShareResponse
	mcpDBSuccess(t, f.call(t, key, "create_share", arguments, headers), &created)
	if created.Id == uuid.Nil || created.ShareUrl == "" {
		t.Fatal("creation omitted share ID or capability URL")
	}
	return created
}

func mcpDBPayload(tool string, arguments any) string {
	return mcpDBJSON(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": tool, "arguments": arguments},
	})
}

func mcpDBJSON(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err) // All inputs are test-owned JSON values.
	}
	return string(data)
}

func mcpDBDecode(t *testing.T, response mcpDBResponse) mcpDBResult {
	t.Helper()
	mcpDBStatus(t, response, http.StatusOK)
	var envelope struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int             `json:"id"`
		Result  mcpDBResult     `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	mcpDBUnmarshal(t, response.body, &envelope)
	if envelope.JSONRPC != "2.0" || envelope.ID != 1 || len(envelope.Error) != 0 {
		t.Fatalf("unexpected JSON-RPC response: %s", response.body)
	}
	result := envelope.Result
	if len(result.Structured) == 0 || len(result.Content) != 1 || result.Content[0].Type != "text" {
		t.Fatalf("missing structured/text tool content: %s", response.body)
	}
	var structured, text bytes.Buffer
	if err := json.Compact(&structured, result.Structured); err != nil {
		t.Fatal(err)
	}
	if err := json.Compact(&text, []byte(result.Content[0].Text)); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(structured.Bytes(), text.Bytes()) {
		t.Fatal("structured and text tool content differ")
	}
	return result
}

func mcpDBSuccess(t *testing.T, result mcpDBResult, target any) {
	t.Helper()
	if result.IsError {
		t.Fatalf("tool failed: %s", result.Structured)
	}
	if target != nil {
		mcpDBUnmarshal(t, result.Structured, target)
	}
}

func mcpDBError(t *testing.T, result mcpDBResult, code ErrorCode) {
	t.Helper()
	var failure Error
	mcpDBUnmarshal(t, result.Structured, &failure)
	if !result.IsError || failure.Code != code || failure.Message == "" {
		t.Fatalf("tool error=%s isError=%v, want %s", result.Structured, result.IsError, code)
	}
}

func mcpDBStatus(t *testing.T, response mcpDBResponse, want int) {
	t.Helper()
	if response.status != want {
		t.Fatalf("HTTP status=%d, want %d; body=%s", response.status, want, response.body)
	}
}

func mcpDBUnmarshal(t *testing.T, data []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatalf("decode JSON: %v; body=%s", err, data)
	}
}

func mcpDBOwner(t *testing.T, f *mcpDBFixture, id, account uuid.UUID) {
	t.Helper()
	if got := testdb.Count(t, f.pool, `SELECT count(*) FROM shares WHERE id=$1 AND account_id=$2`, id, account); got != 1 {
		t.Fatal("share ownership did not come from the current API key")
	}
}

func mcpDBViews(t *testing.T, f *mcpDBFixture, id uuid.UUID, want int64) {
	t.Helper()
	if got := testdb.Count(t, f.pool, `SELECT view_count FROM shares WHERE id=$1`, id); got != want {
		t.Fatalf("stored view_count=%d, want %d", got, want)
	}
}

func mcpDBToken(t *testing.T, created CreateShareResponse) string {
	t.Helper()
	u, err := url.Parse(created.ShareUrl)
	if err != nil {
		t.Fatal(err)
	}
	path := u.Path
	if u.Fragment != "" {
		path = u.Fragment
	}
	token := strings.TrimPrefix(path, "/s/")
	if _, err := share.HashToken(token); err != nil {
		t.Fatalf("creation returned invalid capability: %v", err)
	}
	return token
}

func mcpDBNoIdentity(t *testing.T, response mcpDBResponse, accounts [2]mcpDBAccount) {
	t.Helper()
	if response.header.Get("X-Morsel-Account-ID") != "" {
		t.Fatal("capability read returned an account identity header")
	}
	for _, marker := range []string{"account_id", "owner", "display_name", accounts[0].id.String(), accounts[1].id.String()} {
		if bytes.Contains(response.body, []byte(marker)) {
			t.Fatalf("capability read disclosed identity marker %q", marker)
		}
	}
}

func mcpDBExactNumber(t *testing.T, data []byte, field string, want int64) {
	t.Helper()
	var fields map[string]json.RawMessage
	mcpDBUnmarshal(t, data, &fields)
	if got := string(fields[field]); got != strconv.FormatInt(want, 10) {
		t.Fatalf("raw %s=%s, want %d", field, got, want)
	}
}
