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
	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/narumiruna/morsel/api/internal/telemetry"
)

const testAPIKey = "0123456789abcdef0123456789abcdef"

type repositoryStub struct {
	createResults []share.Share
	createErrors  []error
	created       []share.CreateParams
	consumeResult share.Share
	consumeError  error
	revokeFound   bool
	revokeError   error
	pingError     error
}

func (r *repositoryStub) Create(_ context.Context, params share.CreateParams) (share.Share, error) {
	r.created = append(r.created, params)
	index := len(r.created) - 1
	var result share.Share
	if index < len(r.createResults) {
		result = r.createResults[index]
	}
	if result.ID == uuid.Nil {
		result.ID = params.ID
		result.Content = params.Content
		result.CreatedAt = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
		result.MaxViews = params.MaxViews
	}
	if index < len(r.createErrors) {
		return result, r.createErrors[index]
	}
	return result, nil
}
func (r *repositoryStub) Consume(context.Context, [32]byte) (share.Share, error) {
	return r.consumeResult, r.consumeError
}
func (r *repositoryStub) Revoke(context.Context, uuid.UUID) (bool, error) {
	return r.revokeFound, r.revokeError
}
func (r *repositoryStub) Ping(context.Context) error { return r.pingError }

func testRouter(t *testing.T, repository share.Repository, tokenReader io.Reader, logOutput io.Writer, maxDocumentBytes int64) http.Handler {
	t.Helper()
	viewerURL, _ := url.Parse("https://morsel.example/")
	if tokenReader == nil {
		tokenReader = bytes.NewReader(bytes.Repeat([]byte{0xaa}, share.TokenBytes*4))
	}
	if logOutput == nil {
		logOutput = io.Discard
	}
	logger := slog.New(slog.NewJSONHandler(logOutput, nil))
	service := NewService(repository, share.TokenGenerator{Reader: tokenReader}, viewerURL, maxDocumentBytes, logger)
	return NewRouter(service, RouterConfig{
		APIKeys:        []string{testAPIKey},
		MaxRequestBody: 256, RequestTimeout: time.Second, Logger: logger,
	})
}

func request(t *testing.T, handler http.Handler, method, path, body, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}

func TestCreateShareAuthenticationValidationAndResponse(t *testing.T) {
	repository := &repositoryStub{}
	handler := testRouter(t, repository, nil, nil, 8)
	if response := request(t, handler, http.MethodPost, "/v1/shares", `{"content":"ok"}`, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d", response.Code)
	}
	if response := request(t, handler, http.MethodPost, "/v1/shares", `{"content":"你好"}`, "Bearer "+testAPIKey); response.Code != http.StatusCreated {
		t.Fatalf("UTF-8 valid response=%d %s", response.Code, response.Body.String())
	}
	if response := request(t, handler, http.MethodPost, "/v1/shares", `{"content":"你好啊"}`, "Bearer "+testAPIKey); response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("content limit response=%d %s", response.Code, response.Body.String())
	}
	if response := request(t, handler, http.MethodPost, "/v1/shares", `{"content":"ok","max_views":0}`, "Bearer "+testAPIKey); response.Code != http.StatusBadRequest {
		t.Fatalf("validation response=%d %s", response.Code, response.Body.String())
	}
	if response := request(t, handler, http.MethodPost, "/v1/shares", `{"content":"ok","unknown":true}`, "Bearer "+testAPIKey); response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field response=%d %s", response.Code, response.Body.String())
	}
	if len(repository.created) != 1 {
		t.Fatalf("created calls=%d", len(repository.created))
	}
}

func TestCreateShareRequiresContentAndRejectsNUL(t *testing.T) {
	repository := &repositoryStub{}
	handler := testRouter(t, repository, nil, nil, 100)
	for _, body := range []string{`{}`, `{"content":null}`, `{"content":"\u0000"}`} {
		response := request(t, handler, http.MethodPost, "/v1/shares", body, "Bearer "+testAPIKey)
		if response.Code != http.StatusBadRequest {
			t.Errorf("body=%s status=%d response=%s", body, response.Code, response.Body.String())
		}
	}
	response := request(t, handler, http.MethodPost, "/v1/shares", `{"content":""}`, "Bearer "+testAPIKey)
	if response.Code != http.StatusCreated {
		t.Fatalf("empty content status=%d response=%s", response.Code, response.Body.String())
	}
	if len(repository.created) != 1 || repository.created[0].Content != "" {
		t.Fatalf("created=%+v", repository.created)
	}
}

func TestCreateShareCollisionRecoveryAndFailure(t *testing.T) {
	repository := &repositoryStub{createErrors: []error{share.ErrTokenCollision, nil}}
	entropy := bytes.NewReader(append(bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)...))
	handler := testRouter(t, repository, entropy, nil, 100)
	response := request(t, handler, http.MethodPost, "/v1/shares", `{"content":"hello","max_views":2}`, "Bearer "+testAPIKey)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body CreateShareResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(body.ShareUrl, "https://morsel.example/#/s/") || len(repository.created) != 2 {
		t.Fatalf("response=%+v calls=%d", body, len(repository.created))
	}
	if repository.created[0].TokenHash == repository.created[1].TokenHash {
		t.Fatal("collision retry reused token")
	}

	failed := &repositoryStub{createErrors: []error{share.ErrTokenCollision, share.ErrTokenCollision, share.ErrTokenCollision}}
	handler = testRouter(t, failed, bytes.NewReader(bytes.Repeat([]byte{3}, 96)), nil, 100)
	response = request(t, handler, http.MethodPost, "/v1/shares", `{"content":"hello"}`, "Bearer "+testAPIKey)
	if response.Code != http.StatusInternalServerError || len(failed.created) != maxTokenAttempts {
		t.Fatalf("status=%d attempts=%d", response.Code, len(failed.created))
	}
}

func TestCreateShareEntropyFailureAndWholeBodyLimit(t *testing.T) {
	repository := &repositoryStub{}
	handler := testRouter(t, repository, errorReader{}, nil, 100)
	response := request(t, handler, http.MethodPost, "/v1/shares", `{"content":"hello"}`, "Bearer "+testAPIKey)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("entropy status=%d", response.Code)
	}
	response = request(t, handler, http.MethodPost, "/v1/shares", `{"content":"`+strings.Repeat("x", 300)+`"}`, "Bearer "+testAPIKey)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("body limit status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestConsumeShareStatesAndNoStore(t *testing.T) {
	token, _, _ := (share.TokenGenerator{Reader: bytes.NewReader(bytes.Repeat([]byte{4}, 32))}).Generate()
	id := uuid.New()
	remaining := int64(1)
	repository := &repositoryStub{consumeResult: share.Share{
		ID: id, Content: "# hello", CreatedAt: time.Now(), ViewCount: 1, ViewsRemaining: &remaining,
	}}
	handler := testRouter(t, repository, nil, nil, 100)
	response := request(t, handler, http.MethodGet, "/v1/shares/"+token, "", "")
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	if response := request(t, handler, http.MethodGet, "/v1/shares/not-a-token", "", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("malformed status=%d", response.Code)
	}

	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{share.ErrNotFound, http.StatusNotFound, "not_found"},
		{share.ErrExpired, http.StatusGone, "expired"},
		{share.ErrRevoked, http.StatusGone, "revoked"},
		{share.ErrViewLimitExhausted, http.StatusGone, "view_limit_exhausted"},
		{errors.New("database unavailable"), http.StatusInternalServerError, "internal_error"},
	} {
		repository.consumeError = test.err
		response := request(t, handler, http.MethodGet, "/v1/shares/"+token, "", "")
		if response.Code != test.status || !strings.Contains(response.Body.String(), test.code) {
			t.Fatalf("error %v: status=%d body=%s", test.err, response.Code, response.Body.String())
		}
	}
}

func TestRevokeAndReadiness(t *testing.T) {
	id := uuid.New()
	repository := &repositoryStub{revokeFound: true}
	handler := testRouter(t, repository, nil, nil, 100)
	if response := request(t, handler, http.MethodDelete, "/v1/shares/"+id.String(), "", "Bearer "+testAPIKey); response.Code != http.StatusNoContent {
		t.Fatalf("revoke status=%d body=%s", response.Code, response.Body.String())
	}
	repository.revokeFound = false
	if response := request(t, handler, http.MethodDelete, "/v1/shares/"+id.String(), "", "Bearer "+testAPIKey); response.Code != http.StatusNotFound {
		t.Fatalf("unknown revoke status=%d", response.Code)
	}
	if response := request(t, handler, http.MethodDelete, "/v1/shares/not-uuid", "", "Bearer "+testAPIKey); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid ID status=%d", response.Code)
	}
	if response := request(t, handler, http.MethodGet, "/healthz", "", ""); response.Code != http.StatusOK {
		t.Fatalf("health status=%d", response.Code)
	}
	repository.pingError = errors.New("down")
	if response := request(t, handler, http.MethodGet, "/readyz", "", ""); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready status=%d", response.Code)
	}
}

func TestRouterServesViewerWithoutMaskingUnknownAPIRoutes(t *testing.T) {
	repository := &repositoryStub{}
	viewerURL, _ := url.Parse("https://morsel.example/")
	service := NewService(repository, share.TokenGenerator{}, viewerURL, 100, slog.Default())
	viewerCalls := 0
	router := NewRouter(service, RouterConfig{
		APIKeys: []string{testAPIKey},
		Viewer: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			viewerCalls++
			_, _ = io.WriteString(w, "viewer")
		}),
		MaxRequestBody: 256, RequestTimeout: time.Second, Logger: slog.Default(),
	})

	response := request(t, router, http.MethodGet, "/", "", "")
	if response.Code != http.StatusOK || response.Body.String() != "viewer" || viewerCalls != 1 {
		t.Fatalf("viewer response=%d body=%q calls=%d", response.Code, response.Body.String(), viewerCalls)
	}
	response = request(t, router, http.MethodGet, "/v1/unknown", "", "")
	if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "not_found") || viewerCalls != 1 {
		t.Fatalf("API response=%d body=%q calls=%d", response.Code, response.Body.String(), viewerCalls)
	}
}

func TestSecurityHeadersAndSecretFreeLogs(t *testing.T) {
	token, _, _ := (share.TokenGenerator{Reader: bytes.NewReader(bytes.Repeat([]byte{7}, 32))}).Generate()
	logs := &bytes.Buffer{}
	repository := &repositoryStub{consumeError: errors.New("database unavailable")}
	handler := testRouter(t, repository, nil, logs, 100)

	response := request(t, handler, http.MethodGet, "/v1/shares/"+token, "", "Bearer "+testAPIKey)
	for name, want := range map[string]string{
		"Content-Security-Policy": telemetry.ContentSecurityPolicy,
		"Referrer-Policy":         "no-referrer",
		"X-Content-Type-Options":  "nosniff",
	} {
		if got := response.Header().Get(name); got != want {
			t.Errorf("%s=%q, want %q", name, got, want)
		}
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("cross-origin access was enabled")
	}
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d", response.Code)
	}
	knownID := uuid.New()
	repository.consumeError = nil
	repository.consumeResult = share.Share{ID: knownID, Content: "# hello", CreatedAt: time.Now(), ViewCount: 1}
	response = request(t, handler, http.MethodGet, "/v1/shares/"+token, "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("successful consume status=%d", response.Code)
	}
	logText := logs.String()
	if strings.Contains(logText, token) || strings.Contains(logText, testAPIKey) || strings.Contains(logText, "# hello") {
		t.Fatalf("secret leaked in log: %s", logText)
	}
	for _, field := range []string{`"method":"GET"`, `"route":"/v1/shares/{share}"`, `"status":500`, `"request_id"`, `"latency_ms"`, `"share_id":"` + knownID.String() + `"`} {
		if !strings.Contains(logText, field) {
			t.Fatalf("log missing %s: %s", field, logText)
		}
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, errors.New("entropy unavailable") }
