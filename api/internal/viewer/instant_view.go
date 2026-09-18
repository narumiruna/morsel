package viewer

import (
	"bytes"
	"fmt"
	"html"

	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"golang.org/x/text/unicode/bidi"
)

const viewerRoot = `<div id="root"></div>`

var instantViewMarkdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

func addInstantViewArticle(index []byte, preview share.PreviewMetadata, content string) ([]byte, error) {
	source := []byte(content)
	document := instantViewMarkdown.Parser().Parse(text.NewReader(source))
	var body bytes.Buffer
	if err := instantViewMarkdown.Renderer().Render(&body, source, document); err != nil {
		return nil, fmt.Errorf("render Instant View Markdown: %w", err)
	}

	var article bytes.Buffer
	article.WriteString(`<article data-morsel-instant-view><header>`)
	article.WriteString(`<h1 data-morsel-instant-view-title>`)
	article.WriteString(html.EscapeString(preview.Title))
	article.WriteString(`</h1><p data-morsel-instant-view-description>`)
	article.WriteString(html.EscapeString(preview.Description))
	article.WriteString(`</p></header><div data-morsel-instant-view-body`)
	if isMarkdownRightToLeft(document, source) {
		article.WriteString(` dir="rtl"`)
	}
	article.WriteString(`>`)
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

func isMarkdownRightToLeft(document ast.Node, source []byte) bool {
	rightToLeft := false
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		var visibleText string
		switch node := node.(type) {
		case *ast.Text:
			visibleText = html.UnescapeString(string(node.Segment.Value(source)))
		case *ast.String:
			visibleText = html.UnescapeString(string(node.Value))
		case *ast.CodeBlock:
			visibleText = string(node.Text(source))
		case *ast.FencedCodeBlock:
			visibleText = string(node.Text(source))
		}
		if rtl, found := firstStrongDirection(visibleText); found {
			rightToLeft = rtl
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})
	return rightToLeft
}

func firstStrongDirection(text string) (rightToLeft bool, found bool) {
	for _, r := range text {
		switch bidiClass, _ := bidi.LookupRune(r); bidiClass.Class() {
		case bidi.R, bidi.AL:
			return true, true
		case bidi.L:
			return false, true
		}
	}
	return false, false
}
