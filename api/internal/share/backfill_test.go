package share

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestBackfillBoundedInterruptionResumeAndPreservation(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	for _, suffix := range []string{"1", "2", "3"} {
		if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content,created_at,expires_at,max_views,view_count,revoked_at)
   VALUES(('00000000-0000-0000-0000-00000000000'||$1)::uuid,sha256(convert_to($1,'UTF8')),
   '# **Legacy** [界](https://example.com)','2020-01-01Z','2021-01-01Z',7,3,'2020-12-01Z')`, suffix); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := func() string {
		var data string
		if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(s)-'admin_label' ORDER BY id)::text FROM shares s`).Scan(&data); err != nil {
			t.Fatal(err)
		}
		return data
	}
	before := snapshot()
	for _, batch := range []int{0, 101, -1} {
		if _, err := BackfillLabels(ctx, pool, batch); err == nil {
			t.Fatalf("accepted batch %d", batch)
		}
	}
	// Block row two. Row one must commit independently before cancellation.
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT id FROM shares WHERE id='00000000-0000-0000-0000-000000000002' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	work, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		n   int
		err error
	}
	done := make(chan result, 1)
	go func() { n, err := BackfillLabels(work, pool, 3); done <- result{n, err} }()
	deadline := time.Now().Add(5 * time.Second)
	for testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE admin_label IS NOT NULL`) < 1 {
		if time.Now().After(deadline) {
			t.Fatal("first label did not commit")
		}
		time.Sleep(time.Millisecond * 5)
	}
	cancel()
	got := <-done
	if got.n != 1 || !errors.Is(got.err, context.Canceled) {
		t.Fatalf("interruption: %+v", got)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// PostgreSQL can commit a cancelled autocommit operation before it sees
	// cancellation. Either outcome must be safe to resume and must stay bounded.
	for {
		n, err := BackfillLabels(ctx, pool, 1)
		if err != nil || n > 1 {
			t.Fatalf("resume n=%d err=%v", n, err)
		}
		if n == 0 {
			break
		}
	}
	if after := snapshot(); after != before {
		t.Fatal("backfill changed source, hashes, timestamps, public metadata, or counts")
	}
	if n := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE admin_label='Legacy 界'`); n != 3 {
		t.Fatalf("labels=%d", n)
	}
	// A later older writer is detected rather than omitted from any search.
	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content) VALUES($1,$2,'# Late legacy')`, id, []byte(strings.Repeat("x", 32))); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := NewAdminRepository(tx).List(ctx, AdminListParams{Q: "nothing"}); !errors.Is(err, ErrLabelBackfillRequired) {
		t.Fatalf("omitted older writer: %v", err)
	}
	if _, err := NewAdminRepository(tx).Detail(ctx, id); !errors.Is(err, ErrLabelBackfillRequired) {
		t.Fatalf("pending detail: %v", err)
	}
}
