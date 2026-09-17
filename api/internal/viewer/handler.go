package viewer

import (
	"bytes"
	"context"
	"fmt"
	"html"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/narumiruna/morsel/api/internal/share"
)

const (
	maxPreviewTitleRunes       = 80
	maxPreviewDescriptionRunes = 200
)

type PreviewSource interface {
	Preview(context.Context, [32]byte) (share.Share, error)
}

type Handler struct {
	directory string
	files     http.Handler
	index     []byte
	previews  PreviewSource
}

func New(directory string, previews PreviewSource) (*Handler, error) {
	indexPath := filepath.Join(directory, "index.html")
	info, err := os.Stat(indexPath)
	if err != nil {
		return nil, fmt.Errorf("open viewer index: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("viewer index %q is not a regular file", indexPath)
	}
	index, err := os.ReadFile(indexPath)
	if err != nil {
		return nil, fmt.Errorf("read viewer index: %w", err)
	}
	if !bytes.Contains(index, []byte("</head>")) {
		return nil, fmt.Errorf("viewer index %q has no closing head element", indexPath)
	}
	return &Handler{
		directory: directory,
		files:     http.FileServer(http.Dir(directory)),
		index:     index,
		previews:  previews,
	}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestPath := path.Clean("/" + r.URL.Path)
	if strings.HasPrefix(r.URL.Path, "/s/") && !strings.Contains(strings.TrimPrefix(r.URL.Path, "/s/"), "/") {
		h.serveShare(w, r, strings.TrimPrefix(r.URL.Path, "/s/"))
		return
	}

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

func (h *Handler) serveShare(w http.ResponseWriter, r *http.Request, token string) {
	page := h.index
	if tokenHash, err := share.HashToken(token); err == nil && h.previews != nil {
		if preview, err := h.previews.Preview(r.Context(), tokenHash); err == nil {
			page = addOpenGraphMetadata(page, preview.Content)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(page)))
	if r.Method != http.MethodHead {
		_, _ = w.Write(page)
	}
}

func addOpenGraphMetadata(index []byte, content string) []byte {
	title, description := previewText(content)
	metadata := `<meta property="og:type" content="article">` +
		`<meta property="og:site_name" content="Morsel">` +
		`<meta property="og:title" content="` + html.EscapeString(title) + `">` +
		`<meta property="og:description" content="` + html.EscapeString(description) + `">` +
		`<meta name="description" content="` + html.EscapeString(description) + `">`
	closingHead := []byte("</head>")
	position := bytes.Index(index, closingHead)
	result := make([]byte, 0, len(index)+len(metadata))
	result = append(result, index[:position]...)
	result = append(result, metadata...)
	result = append(result, index[position:]...)
	return result
}

func previewText(content string) (string, string) {
	description := strings.Join(strings.Fields(content), " ")
	title := "Morsel"
	for line := range strings.SplitSeq(content, "\n") {
		candidate := strings.TrimSpace(line)
		candidate = strings.TrimSpace(strings.TrimLeft(candidate, "#>*+-`_~ "))
		if candidate != "" {
			title = candidate
			break
		}
	}
	if description == "" {
		description = "Shared with Morsel."
	}
	return truncateRunes(title, maxPreviewTitleRunes), truncateRunes(description, maxPreviewDescriptionRunes)
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}
