package viewer

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

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
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<!doctype html><head><title>Morsel</title></head>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "assets", "app-abc.js"), []byte("export {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler, err := New(directory, nil)
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
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<!doctype html><head><title>Morsel</title></head><body></body>"), 0o644); err != nil {
		t.Fatal(err)
	}
	token, _, err := (share.TokenGenerator{Reader: strings.NewReader(strings.Repeat("x", share.TokenBytes))}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	previewID := uuid.New()
	source := &previewSourceStub{result: share.Share{ID: previewID, Content: "# A &quot; <unsafe>\n\nBody " + strings.Repeat("長", 220)}}
	handler, err := New(directory, source)
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
	for _, want := range []string{`property="og:title"`, `content="A &#34;"`, `property="og:description"`, `content="Body 長`} {
		if !strings.Contains(body, want) {
			t.Fatalf("preview body missing %q: %s", want, body)
		}
	}
	if strings.Contains(body, "<unsafe>") || source.calls != 1 {
		t.Fatalf("unsafe or unexpected calls: calls=%d body=%s", source.calls, body)
	}
	logText := logs.String()
	if !strings.Contains(logText, `"route":"unmatched"`) || !strings.Contains(logText, `"share_id":"`+previewID.String()+`"`) || strings.Contains(logText, token) || strings.Contains(logText, source.result.Content) {
		t.Fatalf("preview log missing route/share ID or exposed content: %s", logText)
	}

	source.err = errors.New("preview unavailable")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/s/"+token, nil))
	if strings.Contains(response.Body.String(), `property="og:title"`) {
		t.Fatalf("unavailable preview exposed metadata: %s", response.Body.String())
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/s/short", nil))
	if strings.Contains(response.Body.String(), `property="og:title"`) || source.calls != 2 {
		t.Fatalf("malformed preview called source or exposed metadata: calls=%d body=%s", source.calls, response.Body.String())
	}
}

func TestPreviewTextRemovesMarkdownAndHeadingFromDescription(t *testing.T) {
	content := "# Morsel Link Preview 範例\n\n這是一份啟用 **Open Graph preview** 的 Markdown 分享。\n\n> Preview 可重複讀取而不消耗文件的 view。"
	title, description := previewText(content)
	if title != "Morsel Link Preview 範例" {
		t.Fatalf("title=%q", title)
	}
	if description != "這是一份啟用 Open Graph preview 的 Markdown 分享。 Preview 可重複讀取而不消耗文件的 view。" {
		t.Fatalf("description=%q", description)
	}
}

func TestPreviewTextExtractsReadableLinkAndCodeText(t *testing.T) {
	title, description := previewText("## [Release notes](https://example.com)\n\nRun `go test` with **the new build**.")
	if title != "Release notes" || description != "Run go test with the new build." {
		t.Fatalf("title=%q description=%q", title, description)
	}
}

func TestPreviewTextPreservesAutolinks(t *testing.T) {
	title, description := previewText("https://example.com\n\nEmail <user@example.com>.")
	if title != "https://example.com" || description != "https://example.com Email user@example.com." {
		t.Fatalf("title=%q description=%q", title, description)
	}
}

func TestPreviewTextPreservesEntitiesInsideCode(t *testing.T) {
	content := "# Entities\n\nText &lt;tag&gt; and `&lt;code&gt;`.\n\n```html\n&lt;div&gt;\n```"
	title, description := previewText(content)
	if title != "Entities" || description != "Text <tag> and &lt;code&gt;. &lt;div&gt;" {
		t.Fatalf("title=%q description=%q", title, description)
	}
}

func TestPreviewTextUsesFirstItemAsFallbackTitle(t *testing.T) {
	tests := []struct {
		name        string
		content     string
		title       string
		description string
	}{
		{name: "list", content: "- First\n- Second", title: "First", description: "First Second"},
		{name: "table", content: "| Name | Value |\n| --- | --- |\n| First | Second |", title: "Name", description: "Name Value First Second"},
		{name: "blockquote", content: "> First\n>\n> Second", title: "First", description: "First Second"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			title, description := previewText(test.content)
			if title != test.title || description != test.description {
				t.Fatalf("title=%q description=%q", title, description)
			}
		})
	}
}

func TestPreviewTextIsBounded(t *testing.T) {
	title, description := previewText("# " + strings.Repeat("界", 100) + "\n\n" + strings.Repeat("文 ", 150))
	if got := utf8.RuneCountInString(title); got > maxPreviewTitleRunes || !strings.HasSuffix(title, "…") {
		t.Fatalf("title length=%d value=%q", got, title)
	}
	if got := utf8.RuneCountInString(description); got > maxPreviewDescriptionRunes || !strings.HasSuffix(description, "…") {
		t.Fatalf("description length=%d value=%q", got, description)
	}

	title, description = previewText(strings.Repeat(" ", maxPreviewSourceBytes) + "outside prefix")
	if title != "Morsel" || description != "Shared with Morsel." {
		t.Fatalf("preview scanned beyond source bound: title=%q description=%q", title, description)
	}

	prefix := previewSourcePrefix(strings.Repeat("x", maxPreviewSourceBytes-1) + "界outside")
	if len(prefix) > maxPreviewSourceBytes || !utf8.ValidString(prefix) {
		t.Fatalf("prefix length=%d valid=%t", len(prefix), utf8.ValidString(prefix))
	}
}

func TestNewRequiresValidIndex(t *testing.T) {
	if _, err := New(t.TempDir(), nil); err == nil {
		t.Fatal("expected missing index error")
	}
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<title>Morsel</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := New(directory, nil); err == nil {
		t.Fatal("expected closing head error")
	}
}
