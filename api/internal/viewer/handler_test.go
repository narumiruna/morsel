package viewer

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandlerServesIndexAndImmutableAssetsWithoutDirectoryListings(t *testing.T) {
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<!doctype html><title>Morsel</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "assets", "app-abc.js"), []byte("export {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler, err := New(directory)
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

func TestNewRequiresIndex(t *testing.T) {
	if _, err := New(t.TempDir()); err == nil {
		t.Fatal("expected missing index error")
	}
}
