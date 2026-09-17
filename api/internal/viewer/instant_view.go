package viewer

import (
	"bytes"
	"fmt"
	"html"

	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
)

const viewerRoot = `<div id="root"></div>`

var instantViewMarkdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

func addInstantViewArticle(index []byte, preview share.PreviewMetadata, content string) ([]byte, error) {
	var body bytes.Buffer
	if err := instantViewMarkdown.Convert([]byte(content), &body); err != nil {
		return nil, fmt.Errorf("render Instant View Markdown: %w", err)
	}

	var article bytes.Buffer
	article.WriteString(`<article data-morsel-instant-view><header>`)
	article.WriteString(`<h1 data-morsel-instant-view-title>`)
	article.WriteString(html.EscapeString(preview.Title))
	article.WriteString(`</h1><p data-morsel-instant-view-description>`)
	article.WriteString(html.EscapeString(preview.Description))
	article.WriteString(`</p></header><div data-morsel-instant-view-body>`)
	article.Write(body.Bytes())
	article.WriteString(`</div></article>`)

	position := bytes.Index(index, []byte(viewerRoot))
	if position < 0 {
		return nil, fmt.Errorf("viewer index has no root element")
	}
	replacement := make([]byte, 0, len(viewerRoot)+article.Len())
	replacement = append(replacement, `<div id="root">`...)
	replacement = append(replacement, article.Bytes()...)
	replacement = append(replacement, `</div>`...)

	result := make([]byte, 0, len(index)+article.Len())
	result = append(result, index[:position]...)
	result = append(result, replacement...)
	result = append(result, index[position+len(viewerRoot):]...)
	return result, nil
}
