package viewer

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandlerServesIndexAndImmutableAssets(t *testing.T) {
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
}

func TestNewRequiresIndex(t *testing.T) {
	if _, err := New(t.TempDir()); err == nil {
		t.Fatal("expected missing index error")
	}
}
