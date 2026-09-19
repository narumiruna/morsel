package viewer

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/narumiruna/morsel/api/internal/telemetry"
)

type previewSourceStub struct {
	result share.Share
	err    error
	calls  int
}

func (s *previewSourceStub) Preview(context.Context, [32]byte) (share.Share, error) {
	s.calls++
	return s.result, s.err
}

func TestHandlerServesIndexAndImmutableAssetsWithoutDirectoryListings(t *testing.T) {
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte(`<!doctype html><head><title>Morsel</title></head><body><div id="root"></div></body>`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "assets", "app-abc.js"), []byte("export {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler, err := New(directory, nil, testPublicViewerURL(t))
	if err != nil {
		t.Fatal(err)
	}

	index := httptest.NewRecorder()
	handler.ServeHTTP(index, httptest.NewRequest(http.MethodGet, "/", nil))
	if index.Code != http.StatusOK || !strings.Contains(index.Body.String(), "Morsel") {
		t.Fatalf("index status=%d body=%q", index.Code, index.Body.String())
	}
	if got := index.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("index cache control=%q", got)
	}

	gist := httptest.NewRecorder()
	handler.ServeHTTP(gist, httptest.NewRequest(http.MethodGet, "/gist/", nil))
	if gist.Code != http.StatusOK || !strings.Contains(gist.Body.String(), "Morsel") || gist.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("Gist shell status=%d headers=%v body=%q", gist.Code, gist.Header(), gist.Body.String())
	}
	head := httptest.NewRecorder()
	handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/gist/", nil))
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") == "" {
		t.Fatalf("Gist HEAD status=%d length=%q body=%q", head.Code, head.Header().Get("Content-Length"), head.Body.String())
	}
	pathID := httptest.NewRecorder()
	handler.ServeHTTP(pathID, httptest.NewRequest(http.MethodGet, "/gist/7dbaf8170c7292354678069a9acb061f", nil))
	if pathID.Code != http.StatusNotFound {
		t.Fatalf("path-based Gist status=%d body=%q", pathID.Code, pathID.Body.String())
	}

	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/assets/app-abc.js", nil))
	if asset.Code != http.StatusOK || asset.Body.String() != "export {}" {
		t.Fatalf("asset status=%d body=%q", asset.Code, asset.Body.String())
	}
	if got := asset.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("asset cache control=%q", got)
	}

	for _, requestPath := range []string{"/assets", "/assets/"} {
		directory := httptest.NewRecorder()
		handler.ServeHTTP(directory, httptest.NewRequest(http.MethodGet, requestPath, nil))
		if directory.Code != http.StatusNotFound || strings.Contains(directory.Body.String(), "app-abc.js") {
			t.Fatalf("directory %s status=%d body=%q", requestPath, directory.Code, directory.Body.String())
		}
		if got := directory.Header().Get("Cache-Control"); got != "" {
			t.Fatalf("directory %s cache control=%q", requestPath, got)
		}
	}
}

func TestHandlerServesOptInPreviewMetadata(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte(`<!doctype html><head><title>Morsel</title></head><body><div id="root"></div></body>`), 0o644); err != nil {
		t.Fatal(err)
	}
	token, _, err := (share.TokenGenerator{Reader: strings.NewReader(strings.Repeat("x", share.TokenBytes))}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	previewID := uuid.New()
	source := &previewSourceStub{result: share.Share{
		ID: previewID, Content: "SECRET MARKDOWN",
		Preview: &share.PreviewMetadata{
			Title: `A " & <unsafe>`, Description: "Body > details",
			Image: `https://cdn.example/preview.png?a=1&b="quoted"`, Locale: "zh_TW",
		},
	}}
	handler, err := New(directory, source, testPublicViewerURL(t))
	if err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	router := chi.NewRouter()
	router.Use(telemetry.RequestLogger(slog.New(slog.NewJSONHandler(logs, nil))))
	router.Get("/registered", func(http.ResponseWriter, *http.Request) {})
	router.NotFound(handler.ServeHTTP)

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/s/"+token, nil))
	body := response.Body.String()
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d headers=%v", response.Code, response.Header())
	}
	for _, want := range []string{
		`property="og:title"`, `content="A &#34; &amp; &lt;unsafe&gt;"`,
		`property="og:description"`, `content="Body &gt; details"`,
		`property="og:url" content="https://morsel.example/s/` + token + `"`,
		`property="og:image" content="https://cdn.example/preview.png?a=1&amp;b=&#34;quoted&#34;"`,
		`property="og:locale" content="zh_TW"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("preview body missing %q: %s", want, body)
		}
	}
	if strings.Contains(body, "<unsafe>") || strings.Contains(body, source.result.Content) || source.calls != 1 {
		t.Fatalf("unsafe, content-derived, or unexpected result: calls=%d body=%s", source.calls, body)
	}
	logText := logs.String()
	if !strings.Contains(logText, `"route":"unmatched"`) || !strings.Contains(logText, `"share_id":"`+previewID.String()+`"`) || strings.Contains(logText, token) || strings.Contains(logText, source.result.Content) {
		t.Fatalf("preview log missing route/share ID or exposed content: %s", logText)
	}

	head := httptest.NewRecorder()
	handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/s/"+token, nil))
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") == "" || source.calls != 2 {
		t.Fatalf("HEAD status=%d length=%q body=%q calls=%d", head.Code, head.Header().Get("Content-Length"), head.Body.String(), source.calls)
	}

	source.err = errors.New("preview unavailable")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/s/"+token, nil))
	if strings.Contains(response.Body.String(), `property="og:title"`) {
		t.Fatalf("unavailable preview exposed metadata: %s", response.Body.String())
	}

	source.err = nil
	source.result.Preview = nil
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/s/"+token, nil))
	if strings.Contains(response.Body.String(), `property="og:title"`) {
		t.Fatalf("missing preview metadata generated a fallback: %s", response.Body.String())
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/s/short", nil))
	if strings.Contains(response.Body.String(), `property="og:title"`) || source.calls != 4 {
		t.Fatalf("malformed preview called source or exposed metadata: calls=%d body=%s", source.calls, response.Body.String())
	}
}

func TestHandlerServesOptInTelegramInstantViewArticle(t *testing.T) {
	directory := t.TempDir()
	index := `<!doctype html><html><head><title>Morsel</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>`
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte(index), 0o644); err != nil {
		t.Fatal(err)
	}
	token, _, err := (share.TokenGenerator{Reader: strings.NewReader(strings.Repeat("i", share.TokenBytes))}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	source := &previewSourceStub{result: share.Share{
		ID: uuid.New(),
		Content: `## Section

- one
- two

![Cover](https://example.com/cover.png)

` + "```mermaid\ngraph LR\nA-->B\n```" + `

<script>alert("unsafe")</script>

[unsafe](javascript:alert(1))`,
		Preview:             &share.PreviewMetadata{Title: `Title <unsafe>`, Description: `Summary & details`},
		TelegramInstantView: true,
	}}
	handler, err := New(directory, source, testPublicViewerURL(t))
	if err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/s/"+token, nil))
	body := response.Body.String()
	for _, want := range []string{
		`<article data-morsel-instant-view>`,
		`<h1 data-morsel-instant-view-title>Title &lt;unsafe&gt;</h1>`,
		`<p data-morsel-instant-view-description>Summary &amp; details</p>`,
		`<div data-morsel-instant-view-body><h2>Section</h2>`,
		`<img src="https://example.com/cover.png" alt="Cover">`,
		`<code class="language-mermaid">graph LR`,
		`property="og:url" content="https://morsel.example/s/` + token + `"`,
		`<script src="/assets/app.js"></script>`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("Instant View body missing %q: %s", want, body)
		}
	}
	for _, unwanted := range []string{
		`<script>alert`, `href="javascript:`, `data-morsel-instant-view-body dir=`,
		`property="og:image"`, `property="og:locale"`,
	} {
		if strings.Contains(body, unwanted) {
			t.Fatalf("Instant View body contains unsafe output %q: %s", unwanted, body)
		}
	}
	if source.calls != 1 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("calls=%d headers=%v", source.calls, response.Header())
	}

	head := httptest.NewRecorder()
	handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/s/"+token, nil))
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != response.Header().Get("Content-Length") {
		t.Fatalf("HEAD status=%d length=%q body=%q", head.Code, head.Header().Get("Content-Length"), head.Body.String())
	}

	source.err = share.ErrRevoked
	unavailable := httptest.NewRecorder()
	handler.ServeHTTP(unavailable, httptest.NewRequest(http.MethodGet, "/s/"+token, nil))
	if strings.Contains(unavailable.Body.String(), "Full article") || strings.Contains(unavailable.Body.String(), "data-morsel-instant-view") {
		t.Fatalf("unavailable share exposed Instant View content: %s", unavailable.Body.String())
	}
}

func TestNewRequiresValidIndex(t *testing.T) {
	if _, err := New(t.TempDir(), nil, nil); err == nil {
		t.Fatal("expected public viewer URL error")
	}
	for _, rawURL := range []string{
		"ftp://morsel.example/",
		"https://:443/",
		"https://user:secret@morsel.example/",
		"https://morsel.example/app",
		"https://morsel.example/?query=value",
		"https://morsel.example/?",
		"https://morsel.example/#fragment",
	} {
		t.Run(rawURL, func(t *testing.T) {
			parsed, err := url.Parse(rawURL)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := New(t.TempDir(), nil, parsed); err == nil {
				t.Fatal("expected public viewer URL error")
			}
		})
	}
	if _, err := New(t.TempDir(), nil, testPublicViewerURL(t)); err == nil {
		t.Fatal("expected missing index error")
	}
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<title>Morsel</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := New(directory, nil, testPublicViewerURL(t)); err == nil {
		t.Fatal("expected closing head error")
	}
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<head></head><body></body>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := New(directory, nil, testPublicViewerURL(t)); err == nil {
		t.Fatal("expected missing root error")
	}
}

func testPublicViewerURL(t *testing.T) *url.URL {
	t.Helper()
	result, err := url.Parse("https://morsel.example/")
	if err != nil {
		t.Fatal(err)
	}
	return result
}
