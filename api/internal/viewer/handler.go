package viewer

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type Handler struct {
	files http.Handler
}

func New(directory string) (*Handler, error) {
	index := filepath.Join(directory, "index.html")
	info, err := os.Stat(index)
	if err != nil {
		return nil, fmt.Errorf("open viewer index: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("viewer index %q is not a regular file", index)
	}
	return &Handler{files: http.FileServer(http.Dir(directory))}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" || r.URL.Path == "/index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else if strings.HasPrefix(r.URL.Path, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	h.files.ServeHTTP(w, r)
}
