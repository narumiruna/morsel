package viewer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/narumiruna/morsel/api/internal/telemetry"
)

type PreviewSource interface {
	Preview(context.Context, [32]byte) (share.Share, error)
}

type Handler struct {
	directory       string
	files           http.Handler
	index           []byte
	previews        PreviewSource
	publicViewerURL url.URL
}

func New(directory string, previews PreviewSource, publicViewerURL *url.URL) (*Handler, error) {
	if publicViewerURL == nil ||
		(publicViewerURL.Scheme != "https" && publicViewerURL.Scheme != "http") ||
		publicViewerURL.Hostname() == "" || publicViewerURL.User != nil ||
		(publicViewerURL.Path != "" && publicViewerURL.Path != "/") || publicViewerURL.RawPath != "" ||
		publicViewerURL.RawQuery != "" || publicViewerURL.ForceQuery ||
		publicViewerURL.Fragment != "" || publicViewerURL.RawFragment != "" {
		return nil, errors.New("public viewer URL must be an absolute HTTP(S) origin")
	}
	publicViewerOrigin := url.URL{Scheme: publicViewerURL.Scheme, Host: publicViewerURL.Host}
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
	if !bytes.Contains(index, []byte(viewerRoot)) {
		return nil, fmt.Errorf("viewer index %q has no root element", indexPath)
	}
	return &Handler{
		directory:       directory,
		files:           http.FileServer(http.Dir(directory)),
		index:           index,
		previews:        previews,
		publicViewerURL: publicViewerOrigin,
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
		if preview, err := h.previews.Preview(r.Context(), tokenHash); err == nil && preview.Preview != nil {
			telemetry.SetShareID(r.Context(), preview.ID.String())
			shareURL := h.publicViewerURL
			shareURL.Path = "/s/" + token
			page = addOpenGraphMetadata(page, *preview.Preview, shareURL.String())
			if preview.TelegramInstantView {
				if rendered, err := addInstantViewArticle(page, *preview.Preview, preview.Content); err == nil {
					page = rendered
				}
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(page)))
	if r.Method != http.MethodHead {
		_, _ = w.Write(page)
	}
}

func addOpenGraphMetadata(index []byte, preview share.PreviewMetadata, shareURL string) []byte {
	metadata := `<meta property="og:type" content="article">` +
		`<meta property="og:site_name" content="Morsel">` +
		`<meta property="og:title" content="` + html.EscapeString(preview.Title) + `">` +
		`<meta property="og:description" content="` + html.EscapeString(preview.Description) + `">` +
		`<meta property="og:url" content="` + html.EscapeString(shareURL) + `">`
	if preview.Image != "" {
		metadata += `<meta property="og:image" content="` + html.EscapeString(preview.Image) + `">`
	}
	if preview.Locale != "" {
		metadata += `<meta property="og:locale" content="` + html.EscapeString(preview.Locale) + `">`
	}
	metadata += `<meta name="description" content="` + html.EscapeString(preview.Description) + `">`
	closingHead := []byte("</head>")
	position := bytes.Index(index, closingHead)
	result := make([]byte, 0, len(index)+len(metadata))
	result = append(result, index[:position]...)
	result = append(result, metadata...)
	result = append(result, index[position:]...)
	return result
}
