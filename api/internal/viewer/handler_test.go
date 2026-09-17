package viewer

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/narumiruna/morsel/api/internal/share"
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
	source := &previewSourceStub{result: share.Share{Content: "# A &quot; <unsafe>\n\nBody " + strings.Repeat("長", 220)}}
	handler, err := New(directory, source)
	if err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/s/"+token, nil))
	body := response.Body.String()
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d headers=%v", response.Code, response.Header())
	}
	for _, want := range []string{`property="og:title"`, `content="A &amp;quot; &lt;unsafe&gt;"`, `property="og:description"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("preview body missing %q: %s", want, body)
		}
	}
	if strings.Contains(body, "<unsafe>") || source.calls != 1 {
		t.Fatalf("unsafe or unexpected calls: calls=%d body=%s", source.calls, body)
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

func TestPreviewTextIsBounded(t *testing.T) {
	title, description := previewText("# " + strings.Repeat("界", 100) + "\n\n" + strings.Repeat("文 ", 150))
	if got := utf8.RuneCountInString(title); got > maxPreviewTitleRunes || !strings.HasSuffix(title, "…") {
		t.Fatalf("title length=%d value=%q", got, title)
	}
	if got := utf8.RuneCountInString(description); got > maxPreviewDescriptionRunes || !strings.HasSuffix(description, "…") {
		t.Fatalf("description length=%d value=%q", got, description)
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
