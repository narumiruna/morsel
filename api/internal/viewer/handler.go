package viewer

import (
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type Handler struct {
	directory string
	files     http.Handler
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
	return &Handler{directory: directory, files: http.FileServer(http.Dir(directory))}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestPath := path.Clean("/" + r.URL.Path)
	filePath := filepath.Join(h.directory, filepath.FromSlash(strings.TrimPrefix(requestPath, "/")))
	if info, err := os.Stat(filePath); err == nil && info.IsDir() && requestPath != "/" {
		http.NotFound(w, r)
		return
	}
	if requestPath == "/" || requestPath == "/index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else if strings.HasPrefix(requestPath, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	h.files.ServeHTTP(w, r)
}
