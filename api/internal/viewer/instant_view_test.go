package viewer

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/narumiruna/morsel/api/internal/share"
)

func TestInstantViewDirection(t *testing.T) {
	for _, test := range []struct {
		name string
		text string
		want bool
	}{
		{name: "arabic", text: "123 — العربية", want: true},
		{name: "hebrew", text: "עברית", want: true},
		{name: "latin", text: "English العربية", want: false},
		{name: "neutral", text: "123 —", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := isRightToLeft(test.text); got != test.want {
				t.Fatalf("isRightToLeft(%q)=%t, want %t", test.text, got, test.want)
			}
		})
	}

	page, err := addInstantViewArticle(
		[]byte(`<html><body><div id="root"></div></body></html>`),
		share.PreviewMetadata{Title: "العربية", Description: "مستند"},
		"محتوى",
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), `<div data-morsel-instant-view-body dir="rtl">`) {
		t.Fatalf("RTL Instant View body has no direction: %s", page)
	}
}

func TestTelegramInstantViewTemplateIncludesChecklistSafeguards(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate test source")
	}
	templatePath := filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "docs", "telegram-instant-view-template.txt")
	template, err := os.ReadFile(templatePath)
	if err != nil {
		t.Fatal(err)
	}

	for _, want := range []string{
		`?path: /s/[A-Za-z0-9_-]{43}`,
		`!exists: //article[@data-morsel-instant-view]`,
		`image_url: ($body//img)[1]/@src`,
		`@unsupported: $body//code[has-class("language-mermaid") or has-class("language-vega-lite")]`,
	} {
		if !strings.Contains(string(template), want) {
			t.Errorf("Instant View template missing %q", want)
		}
	}
}
