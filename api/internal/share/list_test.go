package share

import (
	"context"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestPostgresRepositoryListOrderingPaginationAndSummaries(t *testing.T) {
	pool := testdb.Open(t)
	repository := NewPostgresRepository(pool)
	ctx := context.Background()
	items, err := repository.List(ctx, 51, 0)
	if err != nil || len(items) != 0 {
		t.Fatalf("empty list=%+v err=%v", items, err)
	}

	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	fixtures := []struct {
		id      int
		created time.Time
		content string
		preview *PreviewMetadata
	}{
		{id: 4, created: base, content: ""},
		{id: 2, created: base.Add(time.Hour), content: "# short content"},
		{id: 9, created: base, content: strings.Repeat("界🙂", 80)},
		{id: 7, created: base.Add(time.Hour), content: strings.Repeat("界🙂", 80) + "PRIVATE TAIL",
			preview: &PreviewMetadata{Title: "Preview title", Description: "Not the excerpt"}},
	}
	expected := make([]Summary, len(fixtures))
	for i, fixture := range fixtures {
		id := uuid.MustParse(fmt.Sprintf("00000000-0000-0000-0000-%012d", fixture.id))
		if _, err := repository.Create(ctx, CreateParams{
			ID: id, TokenHash: uniqueHash(t), Content: fixture.content, Preview: fixture.preview,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, "UPDATE shares SET created_at=$2, view_count=$3 WHERE id=$1", id, fixture.created, i); err != nil {
			t.Fatal(err)
		}
		excerpt := []rune(fixture.content)
		if len(excerpt) > 160 {
			excerpt = excerpt[:160]
		}
		title := ""
		if fixture.preview != nil {
			title = fixture.preview.Title
		}
		expected[i] = Summary{
			ID: id, CreatedAt: fixture.created, Title: title, Excerpt: string(excerpt), ViewCount: int64(i), Status: "active",
		}
	}
	// Timestamp order takes priority over UUID order. UUID breaks timestamp ties.
	want := []Summary{expected[3], expected[1], expected[2], expected[0]}
	sameSummary := func(a, b Summary) bool {
		a.CreatedAt = a.CreatedAt.UTC()
		b.CreatedAt = b.CreatedAt.UTC()
		return reflect.DeepEqual(a, b)
	}
	all, err := repository.List(ctx, 100, 0)
	if err != nil || !slices.EqualFunc(all, want, sameSummary) {
		t.Fatalf("list=%+v want=%+v err=%v", all, want, err)
	}
	for _, item := range all {
		if !utf8.ValidString(item.Excerpt) || utf8.RuneCountInString(item.Excerpt) > 160 || strings.Contains(item.Excerpt, "PRIVATE TAIL") {
			t.Fatalf("invalid excerpt=%q", item.Excerpt)
		}
	}
	for _, test := range []struct {
		limit  int32
		offset int32
		want   []Summary
	}{
		{limit: 3, want: want[:3]}, // Includes the lookahead item for a page size of two.
		{limit: 2, want: want[:2]},
		{limit: 2, offset: 2, want: want[2:]},
		{limit: 2, offset: 3, want: want[3:]},
		{limit: 2, offset: 4, want: []Summary{}},
		{limit: 2, offset: 2147483647, want: []Summary{}},
	} {
		page, err := repository.List(ctx, test.limit, test.offset)
		if err != nil || !slices.EqualFunc(page, test.want, sameSummary) {
			t.Fatalf("limit=%d offset=%d page=%+v want=%+v err=%v", test.limit, test.offset, page, test.want, err)
		}
	}
	if got := testdb.Count(t, pool, "SELECT sum(view_count) FROM shares"); got != 6 {
		t.Fatalf("listing changed view counts: sum=%d", got)
	}
	for _, item := range want {
		if got := testdb.Count(t, pool, "SELECT view_count FROM shares WHERE id=$1", item.ID); got != item.ViewCount {
			t.Fatalf("listing changed %s view count to %d", item.ID, got)
		}
	}
}

func TestPostgresRepositoryListStatuses(t *testing.T) {
	pool := testdb.Open(t)
	repository := NewPostgresRepository(pool)
	ctx := context.Background()
	want := make(map[uuid.UUID]Summary)
	maxViews, expiresIn := int64(2), int64(3600)
	// Check every state combination, including all status priority conflicts.
	for state := range 8 {
		revoked, expired, exhausted := state&4 != 0, state&2 != 0, state&1 != 0
		created, err := repository.Create(ctx, CreateParams{
			ID: uuid.New(), TokenHash: uniqueHash(t), Content: "private", MaxViews: &maxViews, ExpiresIn: &expiresIn,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, err = pool.Exec(ctx, `UPDATE shares SET
			revoked_at = CASE WHEN $2 THEN statement_timestamp() ELSE NULL END,
			expires_at = CASE WHEN $3 THEN statement_timestamp() ELSE expires_at END,
			view_count = CASE WHEN $4 THEN max_views ELSE 1 END
			WHERE id=$1`, created.ID, revoked, expired, exhausted)
		if err != nil {
			t.Fatal(err)
		}
		status := "active"
		switch {
		case revoked:
			status = "revoked"
		case expired:
			status = "expired"
		case exhausted:
			status = "view_limit_exhausted"
		}
		views := int64(1)
		if exhausted {
			views = maxViews
		}
		want[created.ID] = Summary{Status: status, ViewCount: views}
	}
	items, err := repository.List(ctx, 100, 0)
	if err != nil || len(items) != len(want) {
		t.Fatalf("items=%+v err=%v", items, err)
	}
	for _, item := range items {
		expected, ok := want[item.ID]
		if !ok || item.Status != expected.Status || item.ViewCount != expected.ViewCount ||
			item.MaxViews == nil || *item.MaxViews != maxViews || item.ExpiresAt == nil ||
			(item.RevokedAt != nil) != (expected.Status == "revoked") {
			t.Fatalf("item=%+v want=%+v", item, expected)
		}
		if got := testdb.Count(t, pool, "SELECT view_count FROM shares WHERE id=$1", item.ID); got != expected.ViewCount {
			t.Fatalf("listing consumed a view: id=%s count=%d", item.ID, got)
		}
	}
}

func TestPostgresRepositoryListError(t *testing.T) {
	pool := testdb.Open(t)
	repository := NewPostgresRepository(pool)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := repository.List(ctx, 51, 0); err == nil {
		t.Fatal("expected query error for a canceled context")
	}
}
