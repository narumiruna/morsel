package viewer

import (
	"bufio"
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
	"github.com/narumiruna/morsel/api/internal/telemetry"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	markdownhtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/text"
)

const (
	maxPreviewTitleRunes       = 80
	maxPreviewDescriptionRunes = 200
	maxPreviewSourceBytes      = 4 << 10
)

var (
	previewMarkdown   = goldmark.New(goldmark.WithExtensions(extension.GFM))
	previewTextWriter = markdownhtml.NewWriter()
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
			telemetry.SetShareID(r.Context(), preview.ID.String())
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
	source := []byte(previewSourcePrefix(content))
	document := previewMarkdown.Parser().Parse(text.NewReader(source))
	title := "Morsel"
	titleFound := false
	parts := make([]string, 0, document.ChildCount())
	for block := document.FirstChild(); block != nil; block = block.NextSibling() {
		plainText := previewNodeText(block, source)
		if plainText == "" {
			continue
		}
		if !titleFound {
			title = previewTitleText(block, source)
			titleFound = true
			if _, isHeading := block.(*ast.Heading); isHeading {
				continue
			}
		}
		parts = append(parts, plainText)
	}
	description := strings.Join(parts, " ")
	if description == "" {
		description = "Shared with Morsel."
	}
	return truncateRunes(title, maxPreviewTitleRunes), truncateRunes(description, maxPreviewDescriptionRunes)
}

func previewTitleText(node ast.Node, source []byte) string {
	for child := node.FirstChild(); child != nil; child = child.NextSibling() {
		if child.Type() != ast.TypeBlock {
			continue
		}
		if title := previewTitleText(child, source); title != "" {
			return title
		}
	}
	return previewNodeText(node, source)
}

func previewNodeText(node ast.Node, source []byte) string {
	var result strings.Builder
	buffered := bufio.NewWriter(&result)
	_ = ast.Walk(node, func(current ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			if current.Type() == ast.TypeBlock {
				_ = buffered.WriteByte(' ')
			}
			return ast.WalkContinue, nil
		}
		switch current := current.(type) {
		case *ast.Text:
			if current.IsRaw() {
				previewTextWriter.RawWrite(buffered, current.Value(source))
			} else {
				previewTextWriter.Write(buffered, current.Value(source))
			}
			if current.SoftLineBreak() || current.HardLineBreak() {
				_ = buffered.WriteByte(' ')
			}
		case *ast.String:
			if current.IsRaw() || current.IsCode() {
				previewTextWriter.RawWrite(buffered, current.Value)
			} else {
				previewTextWriter.Write(buffered, current.Value)
			}
		case *ast.AutoLink:
			previewTextWriter.RawWrite(buffered, current.Label(source))
		case *ast.CodeBlock:
			writePreviewLines(buffered, current.Lines(), source)
			return ast.WalkSkipChildren, nil
		case *ast.FencedCodeBlock:
			writePreviewLines(buffered, current.Lines(), source)
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	_ = buffered.Flush()
	return html.UnescapeString(strings.Join(strings.Fields(result.String()), " "))
}

func writePreviewLines(result *bufio.Writer, lines *text.Segments, source []byte) {
	for index := 0; index < lines.Len(); index++ {
		line := lines.At(index)
		previewTextWriter.RawWrite(result, line.Value(source))
		_ = result.WriteByte(' ')
	}
}

func previewSourcePrefix(content string) string {
	if len(content) <= maxPreviewSourceBytes {
		return content
	}
	content = content[:maxPreviewSourceBytes]
	for !utf8.ValidString(content) {
		content = content[:len(content)-1]
	}
	return content
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}
