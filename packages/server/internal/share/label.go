package share

import (
	"bufio"
	"html"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	goldmarkhtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/text"
)

var labelMarkdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

// NormalizeLabel preserves explicit plain-text titles. Source labels use the
// first meaningful rendered line. It never changes source or preview metadata.
// Parse once at creation/backfill, never in an authorized list transaction.
func NormalizeLabel(content string, title *string) string {
	if title != nil {
		return boundLabel(*title)
	}
	source := []byte(content)
	document := labelMarkdown.Parser().Parse(text.NewReader(source))
	var line strings.Builder
	var result string
	finish := func() bool {
		result = strings.TrimSpace(line.String())
		line.Reset()
		return result != ""
	}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			if node.Type() == ast.TypeBlock && finish() {
				return ast.WalkStop, nil
			}
			return ast.WalkContinue, nil
		}
		var value string
		switch n := node.(type) {
		case *ast.HTMLBlock, *ast.RawHTML:
			return ast.WalkSkipChildren, nil
		case *ast.Text:
			v := n.Segment.Value(source)
			if n.IsRaw() {
				value = string(v)
			} else {
				value = labelText(v)
			}
		case *ast.String:
			value = string(n.Value)
		case *ast.AutoLink:
			value = string(n.Label(source))
		case *ast.CodeBlock:
			value = string(n.Text(source))
		case *ast.FencedCodeBlock:
			value = string(n.Text(source))
		}
		for _, part := range strings.SplitAfter(value, "\n") {
			line.WriteString(part)
			if strings.HasSuffix(part, "\n") && finish() {
				return ast.WalkStop, nil
			}
		}
		if n, ok := node.(*ast.Text); ok && (n.SoftLineBreak() || n.HardLineBreak()) && finish() {
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})
	if result == "" {
		finish()
	}
	return boundLabel(result)
}

// Use Goldmark's writer so escaped ampersands and nested character references
// are resolved exactly once, as in the rendered document, not by a second parser.
func labelText(value []byte) string {
	var escaped strings.Builder
	writer := bufio.NewWriter(&escaped)
	goldmarkhtml.DefaultWriter.Write(writer, value)
	_ = writer.Flush() // strings.Builder writes cannot fail.
	return html.UnescapeString(escaped.String())
}

func boundLabel(label string) string {
	if strings.TrimSpace(label) == "" {
		return "Untitled"
	}
	runes := []rune(label)
	if len(runes) > 80 {
		return string(runes[:80])
	}
	return label
}
