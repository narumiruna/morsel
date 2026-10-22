package share

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestAdminPaginationAndNonConsumingDetails(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	// These rows predate account setup and have identical timestamps.
	if _, err := pool.Exec(ctx, `INSERT INTO shares (id,token_hash,content,created_at)
		SELECT md5(n::text)::uuid,sha256(convert_to(n::text,'UTF8')),'private Markdown '||n,'2020-01-01Z'
		FROM generate_series(1,107) n`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content,created_at) VALUES
		('00000000-0000-0000-0000-000000000000',sha256('old'::bytea),'oldest','2010-01-01Z'),
		('ffffffff-ffff-ffff-ffff-ffffffffffff',sha256('new'::bytea),'newest','2030-01-01Z')`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := BackfillLabels(ctx, pool, 100); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	r := NewAdminRepository(tx)
	page, err := r.List(ctx, AdminListParams{})
	if err != nil || len(page.Items) != 25 || page.NextCursor == "" || page.Items[0].Label != "newest" {
		t.Fatalf("default page: %+v %v", page, err)
	}
	maximum, err := r.List(ctx, AdminListParams{Limit: 100})
	if err != nil || len(maximum.Items) != 100 || maximum.NextCursor == "" {
		t.Fatalf("maximum page: %+v %v", maximum, err)
	}
	seen := map[uuid.UUID]bool{}
	var previous *AdminMetadata
	cursor := ""
	for {
		page, err := r.List(ctx, AdminListParams{Limit: 13, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			if seen[item.ID] || (previous != nil && (item.CreatedAt.After(previous.CreatedAt) || (item.CreatedAt.Equal(previous.CreatedAt) && item.ID.String() >= previous.ID.String()))) {
				t.Fatalf("duplicate or unordered item %+v after %+v", item, previous)
			}
			seen[item.ID], previous = true, &item
			detail, err := r.Detail(ctx, item.ID)
			if err != nil || detail.Content != item.Label || detail.ViewCount != 0 || detail.AdminMetadata != item {
				t.Fatalf("detail: %+v %v", detail, err)
			}
		}
		cursor = page.NextCursor
		if cursor == "" {
			break
		}
	}
	if len(seen) != 109 {
		t.Fatalf("listed %d rows", len(seen))
	}
	if _, err := r.Detail(ctx, uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing detail: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if n := testdb.Count(t, pool, `SELECT sum(view_count) FROM shares`); n != 0 {
		t.Fatalf("administration consumed %d views", n)
	}
}

func TestAdminStatusesLabelsAndUnavailableDetails(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	type fixture struct {
		status, content, title, label string
		expired, exhausted, revoked   bool
	}
	fixtures := []fixture{
		{status: "active", content: "\n \t\r\n  First line  \nsecond", label: "First line"},
		{status: "active", content: "\n\t\r\n", label: "Untitled"},
		{status: "active", content: "\u00a0\n\u3000 Unicode line\u00a0\nsecond", label: "Unicode line"},
		{status: "active", content: "<b>" + strings.Repeat("界", 100), label: strings.Repeat("界", 80)},
		{status: "active", content: "not the title", title: "Preview title", label: "Preview title"},
		{status: "view_limit_exhausted", content: "exhausted", label: "exhausted", exhausted: true},
		{status: "expired", content: "expired", label: "expired", expired: true, exhausted: true},
		{status: "revoked", content: "revoked", label: "revoked", expired: true, exhausted: true, revoked: true},
	}
	ids := make([]uuid.UUID, len(fixtures))
	for i, f := range fixtures {
		ids[i] = uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO shares
			(id,token_hash,content,preview_title,preview_description,expires_at,max_views,view_count,revoked_at)
			VALUES ($1,$2,$3,NULLIF($4,''),CASE WHEN $4='' THEN NULL ELSE 'description' END,
			CASE WHEN $5 THEN statement_timestamp()-interval '1 second' ELSE NULL END,
			CASE WHEN $6 THEN 1 ELSE NULL END, CASE WHEN $6 THEN 1 ELSE 0 END,
			CASE WHEN $7 THEN statement_timestamp() ELSE NULL END)`, ids[i], []byte(fmt.Sprintf("%032d", i)), f.content, f.title, f.expired, f.exhausted, f.revoked); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := BackfillLabels(ctx, pool, 100); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	r := NewAdminRepository(tx)
	for i, f := range fixtures {
		detail, err := r.Detail(ctx, ids[i])
		if err != nil || detail.Status != f.status || detail.Label != f.label || detail.Content != f.content || utf8.RuneCountInString(detail.Label) > 80 {
			t.Fatalf("fixture %d: %+v %v", i, detail, err)
		}
	}
	for _, status := range []string{"all", "active", "revoked", "expired", "view_limit_exhausted"} {
		page, err := r.List(ctx, AdminListParams{Status: status, Limit: 1})
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for {
			for _, item := range page.Items {
				if status != "all" && item.Status != status {
					t.Fatalf("filter %s returned %s", status, item.Status)
				}
				count++
			}
			if page.NextCursor == "" {
				break
			}
			page, err = r.List(ctx, AdminListParams{Status: status, Limit: 1, Cursor: page.NextCursor})
			if err != nil {
				t.Fatal(err)
			}
		}
		want := 1
		if status == "all" {
			want = len(fixtures)
		} else if status == "active" {
			want = 5
		}
		if count != want {
			t.Fatalf("%s count=%d want=%d", status, count, want)
		}
	}
	for range 2 {
		if found, err := r.Revoke(ctx, ids[0]); err != nil || !found {
			t.Fatalf("revoke: %t %v", found, err)
		}
	}
	if found, err := r.Revoke(ctx, uuid.New()); err != nil || found {
		t.Fatalf("unknown revoke: %t %v", found, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if n := testdb.Count(t, pool, `SELECT sum(view_count) FROM shares`); n != 3 {
		t.Fatalf("view counts changed to %d", n)
	}
}

func TestAdminCursorValidation(t *testing.T) {
	pool := testdb.Open(t)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	r := NewAdminRepository(tx)
	encode := func(value string) string { return base64.RawURLEncoding.EncodeToString([]byte(value)) }
	for _, params := range []AdminListParams{
		{Status: "unknown"}, {Limit: -1}, {Limit: 101},
		{Cursor: "!"}, {Cursor: strings.Repeat("a", 513)}, {Cursor: encode(`{}`)},
		{Cursor: encode(`{"v":1,"status":"active","created_at":"2020-01-01T00:00:00Z","id":"00000000-0000-0000-0000-000000000001"}`)},
		{Cursor: encode(`{"v":2,"status":"all","created_at":"2020-01-01T00:00:00Z","id":"00000000-0000-0000-0000-000000000001"}`)},
		{Cursor: encode(`{"v":1,"status":"all","created_at":"bad","id":"bad"}`)},
		{Cursor: encode(`{"v":1,"status":"all","created_at":"2020-01-01T00:00:00Z"}`)},
		{Cursor: encode(`{"v":1,"status":"all","created_at":"2020-01-01T00:00:00Z","id":"00000000-0000-0000-0000-000000000001","extra":1}`)},
		{Cursor: encode(`{} {}`)},
	} {
		if _, err := r.List(t.Context(), params); !errors.Is(err, ErrInvalidAdminParams) {
			t.Fatalf("accepted %+v: %v", params, err)
		}
	}
	page, err := r.List(t.Context(), AdminListParams{})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(page)
	if string(data) != `{"items":[],"matching_count":0}` {
		t.Fatalf("empty page: %s", data)
	}
}

func TestAdminStatusUsesStatementTime(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	id := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO shares(id,token_hash,content,admin_label,expires_at) VALUES($1,$2,'timed','timed',statement_timestamp()+interval '50 milliseconds')`, id, []byte(strings.Repeat("a", 32))); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_sleep(0.06)`); err != nil {
		t.Fatal(err)
	}
	detail, err := NewAdminRepository(tx).Detail(ctx, id)
	if err != nil || detail.Status != "expired" {
		t.Fatalf("status used transaction or application time: %+v %v", detail, err)
	}
}
