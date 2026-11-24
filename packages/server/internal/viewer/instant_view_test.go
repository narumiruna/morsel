package viewer

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/narumiruna/morsel/packages/server/internal/share"
)

func TestInstantViewDirectionFollowsRenderedMarkdown(t *testing.T) {
	for _, test := range []struct {
		name    string
		preview share.PreviewMetadata
		content string
		wantRTL bool
	}{
		{
			name:    "Arabic body with English metadata",
			preview: share.PreviewMetadata{Title: "English", Description: "English summary"},
			content: `123 — &amp; [العربية](https://example.com)`,
			wantRTL: true,
		},
		{
			name:    "English image alt before Arabic body",
			preview: share.PreviewMetadata{Title: "Preview", Description: "Summary"},
			content: "![Cover](https://example.com/cover.png)\n\nالعربية",
			wantRTL: true,
		},
		{
			name:    "English body with Arabic metadata",
			preview: share.PreviewMetadata{Title: "العربية", Description: "ملخص"},
			content: "English body",
			wantRTL: false,
		},
		{
			name:    "English autolink before Arabic body",
			preview: share.PreviewMetadata{Title: "Preview", Description: "Summary"},
			content: "https://example.com\n\nالعربية",
			wantRTL: false,
		},
		{
			name:    "Hebrew body",
			preview: share.PreviewMetadata{Title: "Preview", Description: "Summary"},
			content: "עברית",
			wantRTL: true,
		},
		{
			name:    "Neutral body",
			preview: share.PreviewMetadata{Title: "العربية", Description: "ملخص"},
			content: "123 —",
			wantRTL: false,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			page, err := addInstantViewArticle(
				[]byte(`<html><body><div id="root"></div></body></html>`),
				test.preview,
				test.content,
			)
			if err != nil {
				t.Fatal(err)
			}
			gotRTL := strings.Contains(string(page), `<div data-morsel-instant-view-body dir="rtl">`)
			if gotRTL != test.wantRTL {
				t.Fatalf("RTL body=%t, want %t: %s", gotRTL, test.wantRTL, page)
			}
		})
	}
}

func TestTelegramInstantViewTemplate(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate test source")
	}
	templatePath := filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "..", "docs", "telegram-instant-view-template.txt")
	template, err := os.ReadFile(templatePath)
	if err != nil {
		t.Fatal(err)
	}

	lines := strings.Split(string(template), "\n")
	var pathPattern string
	for _, line := range lines {
		if pattern, ok := strings.CutPrefix(line, "?path: "); ok {
			pathPattern = pattern
			break
		}
	}
	if pathPattern == "" {
		t.Fatal("Instant View template missing ?path pattern")
	}
	pattern, err := regexp.Compile(pathPattern)
	if err != nil {
		t.Fatalf("invalid Instant View path pattern: %v", err)
	}
	for _, test := range previewTokenCases {
		t.Run(test.name, func(t *testing.T) {
			path := "/s/" + test.token
			if !pattern.MatchString(path) {
				t.Errorf("path pattern %q rejected %q", pathPattern, path)
			}
			for _, invalid := range []string{"/prefix" + path, path + "/extra"} {
				if pattern.MatchString(invalid) {
					t.Errorf("path pattern %q matched %q", pathPattern, invalid)
				}
			}
		})
	}
	for _, invalid := range []string{
		"/s/" + base64URLShareToken + "=",
		"/s/" + base64URLShareToken[:len(base64URLShareToken)-1] + "1", // Nonzero Base64URL padding bits.
		"/s/" + strings.ToUpper(lowercaseHexShareToken),
		"/s/" + lowercaseHexShareToken[:len(lowercaseHexShareToken)-1] + "g",
	} {
		if pattern.MatchString(invalid) {
			t.Errorf("path pattern %q matched %q", pathPattern, invalid)
		}
	}

	for _, want := range []string{
		`!exists: //article[@data-morsel-instant-view]`,
		`image_url: //meta[@property="og:image"]/@content`,
		`image_url: $body//img/@src`,
	} {
		if !slices.Contains(lines, want) {
			t.Errorf("Instant View template missing %q", want)
		}
	}

	if strings.Contains(string(template), `@unsupported: $body//code[has-class("language-mermaid") or has-class("language-vega-lite")]`) {
		t.Error("Instant View template rejects diagram source fallback")
	}
}
