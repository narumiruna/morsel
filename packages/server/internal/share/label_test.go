package share

import (
	"strings"
	"testing"
	"time"

	"github.com/narumiruna/morsel/packages/server/internal/testdb"
)

func TestNormalizeLabel(t *testing.T) {
	for _, tc := range []struct{ source, want string }{
		{"\n # **Hello** [world](https://example.com) `code`", "Hello world code"},
		{`\*literal\* &amp; &#30028;`, "*literal* & 界"},
		{`\&amp; &#38;amp; &amp;#30028;`, `&amp; &amp; &#30028;`},
		{`\[label\]\(destination\) \<b\>`, `[label](destination) <b>`},
		{"# [**nested** `code`](https://example.com \"title\")", "nested code"},
		{"# [reference][id]\n\n[id]: https://secret.example", "reference"},
		{"~~deleted~~ and **bold**", "deleted and bold"},
		{"> # quoted *text*", "quoted text"},
		{"- **list** item", "list item"},
		{"[outer **inner**](https://example.com)", "outer inner"},
		{"`a &amp; \\*b`", `a &amp; \*b`},
		{"<b>Hello</b> **world**", "Hello world"},
		{"<div>authored HTML</div>\n\n# Markdown", "Markdown"},
		{"<!-- hidden -->\n\n", "Untitled"},
		{"\n\u3000\n\n---\n\n# 界Éclair", "界Éclair"},
		{"first\nsecond", "first"},
		{"```go\ncode &amp;\n```", "code &amp;"},
		{"![image label](https://example.com/image)", "image label"},
		{"# " + strings.Repeat("界", 100), strings.Repeat("界", 80)},
		{"", "Untitled"},
	} {
		if got := NormalizeLabel(tc.source, nil); got != tc.want {
			t.Errorf("%q: got %q want %q", tc.source, got, tc.want)
		}
	}
	title := "**Authored** &amp; <b>plain</b>"
	if got := NormalizeLabel("# ignored", &title); got != title {
		t.Fatalf("explicit title changed: %q", got)
	}
	title = strings.Repeat("界", 100)
	if got := NormalizeLabel("ignored", &title); got != strings.Repeat("界", 80) {
		t.Fatalf("explicit Unicode bound: %q", got)
	}
	title = "\u3000\t"
	if got := NormalizeLabel("ignored", &title); got != "Untitled" {
		t.Fatalf("empty title fallback: %q", got)
	}
	// Do not stop at an arbitrary source prefix: late reference definitions
	// must produce the same label as ordinary links.
	source := "# [Reference][late]\n\n" + strings.Repeat("paragraph\n\n", 10000) + "[late]: https://destination.invalid\n"
	if got := NormalizeLabel(source, nil); got != "Reference" {
		t.Fatalf("late reference label=%q", got)
	}
	// Truncate after line normalization, not before trailing spaces become
	// internal spaces across inline nodes.
	source = "foo" + strings.Repeat(" ", 100) + "**bar**"
	if got := NormalizeLabel(source, nil); got != "foo"+strings.Repeat(" ", 77) {
		t.Fatalf("line normalization order: %q", got)
	}
}

// Generated fixtures and EXPLAIN keep the storage decision reproducible. All
// objects are isolated in testdb's temporary schema; no production writes.
func TestLabelDiscovery(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	content := "# **Résumé** [界](https://example.com) `code`\n\n" + strings.Repeat("ordinary paragraph with [link](https://example.com).\n\n", 1200)
	start := time.Now()
	for range 100 {
		NormalizeLabel(content, nil)
	}
	t.Logf("Goldmark: 100 x %d-byte documents in %s", len(content), time.Since(start))
	_, err := pool.Exec(ctx, `CREATE TEMP TABLE label_discovery AS SELECT n,
  '# **Résumé** [界](https://example.com) `+"`code`"+`' || repeat(E'\nparagraph [link](https://example.com).',1600) AS content,
  'Résumé 界 code ' || n AS label, now() - n * interval '1 second' AS created_at
  FROM generate_series(1,10000) n;
  CREATE INDEX ON label_discovery(created_at DESC,n DESC);
  ANALYZE label_discovery`)
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`SELECT count(*) FROM label_discovery WHERE strpos(lower(label),lower('RÉSUMÉ'))>0`,
		`SELECT label FROM label_discovery WHERE strpos(lower(label),lower('RÉSUMÉ'))>0 ORDER BY created_at DESC,n DESC LIMIT 26`,
		`SELECT count(*) FROM label_discovery WHERE strpos(lower(split_part(content,E'\n',1)),lower('RÉSUMÉ'))>0`,
	} {
		rows, err := pool.Query(ctx, "EXPLAIN (ANALYZE,BUFFERS) "+query)
		if err != nil {
			t.Fatal(err)
		}
		t.Log(query)
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			t.Log(line)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
	}
}
