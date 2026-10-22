package share

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestAdminGlobalLiteralSearchAndCounts(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	// Raw inserts are legacy shares. Every label must become searchable, not
	// merely the first page or the subset created by the new server.
	sources := []string{"# **Éclair** [世界](https://destination.invalid)", `literal % _ \ [bracket]`, "# " + strings.Repeat("界", 80) + "UNSEARCHABLE", "<!-- hidden -->", "# other"}
	for i, source := range sources {
		_, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content,created_at,revoked_at)
   VALUES($1,$2,$3,'2020-01-01Z',CASE WHEN $4 THEN now() ELSE NULL END)`, uuid.New(), []byte(fmt.Sprintf("%032d", i)), source, i == 4)
		if err != nil {
			t.Fatal(err)
		}
	}
	read := func(p AdminListParams) (AdminPage, error) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return AdminPage{}, err
		}
		defer tx.Rollback(ctx)
		return NewAdminRepository(tx).List(ctx, p)
	}
	for _, q := range []string{"", "no matching rows"} {
		if _, err := read(AdminListParams{Q: q}); !errors.Is(err, ErrLabelBackfillRequired) {
			t.Fatalf("pending q=%q: %v", q, err)
		}
	}
	for {
		n, err := BackfillLabels(ctx, pool, 2)
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
	}
	repo := NewPostgresRepository(pool)
	title := "**Explicit** <b> &amp; _ %"
	if _, err := repo.Create(ctx, CreateParams{ID: uuid.New(), TokenHash: [32]byte{255}, Content: "# ignored", Preview: &PreviewMetadata{Title: title, Description: "description"}}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		q, status string
		want      int64
	}{
		{"", "", 6}, {" \u3000éCLAIR\u00a0 ", "", 1}, {"世界", "", 1}, {"destination.invalid", "", 0},
		{"%", "", 2}, {"_", "", 2}, {`\`, "", 1}, {"[bracket]", "", 1}, {"Untitled", "", 1},
		{"UNSEARCHABLE", "", 0}, {"\x00", "", 0}, {"Éclair\x00", "", 0}, {strings.Repeat("界", 80), "", 1}, {"**Explicit**", "", 1},
		{"&amp;", "", 1}, {"other", "active", 0}, {"other", "revoked", 1}, {"", "expired", 0},
	} {
		page, err := read(AdminListParams{Q: tc.q, Status: tc.status, Limit: 1})
		if err != nil || page.MatchingCount != tc.want || len(page.Items) != int(min(tc.want, 1)) {
			t.Fatalf("q=%q status=%s: %+v %v", tc.q, tc.status, page, err)
		}
		for page.NextCursor != "" {
			page, err = read(AdminListParams{Q: tc.q, Status: tc.status, Limit: 1, Cursor: page.NextCursor})
			if err != nil || page.MatchingCount != tc.want {
				t.Fatalf("count changed across cursor: %+v %v", page, err)
			}
		}
	}
	if n := testdb.Count(t, pool, `SELECT sum(view_count) FROM shares`); n != 0 {
		t.Fatalf("consumed %d", n)
	}
}

func TestAdminSortAndQueryBoundCursors(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content,admin_label,created_at)
  SELECT md5(n::text)::uuid,sha256(convert_to(n::text,'UTF8')),'# Éclair','Éclair','2020-01-01Z'::timestamptz + (n%3)*interval '1 day' FROM generate_series(1,31) n`); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	r := NewAdminRepository(tx)
	var descending []uuid.UUID
	for _, sort := range []string{"newest", "oldest"} {
		cursor := ""
		var items []AdminMetadata
		for {
			page, err := r.List(ctx, AdminListParams{Q: " Éclair ", Sort: sort, Limit: 4, Cursor: cursor})
			if err != nil {
				t.Fatal(err)
			}
			if page.MatchingCount != 31 {
				t.Fatalf("count=%d", page.MatchingCount)
			}
			items = append(items, page.Items...)
			cursor = page.NextCursor
			if len(cursor) > 512 {
				t.Fatal("unbounded cursor")
			}
			if cursor == "" {
				break
			}
		}
		if len(items) != 31 {
			t.Fatalf("sort=%s items=%d", sort, len(items))
		}
		for i, item := range items {
			if sort == "newest" {
				descending = append(descending, item.ID)
			} else if item.ID != descending[len(descending)-1-i] {
				t.Fatal("oldest is not exact stable reverse")
			}
			if i > 0 {
				prev := items[i-1]
				less := item.CreatedAt.Before(prev.CreatedAt) || (item.CreatedAt.Equal(prev.CreatedAt) && item.ID.String() < prev.ID.String())
				if (sort == "newest") != less {
					t.Fatal("unstable ordering")
				}
			}
		}
	}
	page, err := r.List(ctx, AdminListParams{Limit: 1, Q: " Éclair "})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []AdminListParams{{Q: "different"}, {Q: "Éclair", Status: "active"}, {Q: "Éclair", Sort: "oldest"}} {
		p.Cursor = page.NextCursor
		if _, err := r.List(ctx, p); !errors.Is(err, ErrInvalidAdminParams) {
			t.Fatalf("accepted mismatch %+v: %v", p, err)
		}
	}
	if _, err := r.List(ctx, AdminListParams{Q: "Éclair", Limit: 7, Cursor: page.NextCursor}); err != nil {
		t.Fatalf("trimmed equivalent q/changed page size: %v", err)
	}
	id := uuid.New()
	b, _ := json.Marshal(adminCursor{Version: 1, Status: "all", CreatedAt: time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC), ID: &id})
	v1 := base64.RawURLEncoding.EncodeToString(b)
	for _, p := range []AdminListParams{{Cursor: v1}, {Cursor: v1, Q: "\u3000", Sort: "newest"}} {
		page, err := r.List(ctx, p)
		if err != nil || len(page.Items) != 25 {
			t.Fatalf("legacy cursor: %+v %v", page, err)
		}
	}
	for _, p := range []AdminListParams{{Cursor: v1, Q: "Éclair"}, {Cursor: v1, Sort: "oldest"}, {Q: strings.Repeat("界", 101)}, {Q: string([]byte{255})}, {Sort: "NEWEST"}} {
		if _, err := r.List(ctx, p); !errors.Is(err, ErrInvalidAdminParams) {
			t.Fatalf("accepted %+v: %v", p, err)
		}
	}
	// Long Unicode query size does not enter the cursor; SHA-256 is fixed size.
	long := strings.Repeat("界", 100)
	b, _ = json.Marshal(adminCursor{Version: 2, Status: "view_limit_exhausted", CreatedAt: time.Now(), ID: &id, Sort: "newest", SearchHash: searchHash(long)})
	if n := len(base64.RawURLEncoding.EncodeToString(b)); n > 512 {
		t.Fatalf("cursor length=%d", n)
	}
}
