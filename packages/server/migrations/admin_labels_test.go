package migrations_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
	"github.com/narumiruna/morsel/packages/server/migrations"
)

func TestAdminLabelsAdditiveRollbackAndRecovery(t *testing.T) {
	pool := testdb.OpenVersion(t, 7)
	ctx := t.Context()
	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content,preview_title,preview_description,max_views,view_count,revoked_at)
  VALUES($1,$2,'# source remains **unchanged**','**Plain authored title**','Description',7,2,'2020-01-01Z')`, id, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		var data string
		if err := pool.QueryRow(ctx, `SELECT (to_jsonb(shares)-'admin_label'-'link_ciphertext'-'link_token')::text FROM shares WHERE id=$1`, id).Scan(&data); err != nil {
			t.Fatal(err)
		}
		return data
	}
	before := snapshot()
	for range 2 {
		if err := migrations.Run(ctx, pool, migrations.Up, 3); err != nil {
			t.Fatal(err)
		}
		if n := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE admin_label IS NULL`); n != 1 {
			t.Fatal("schema migration rewrote source-derived labels")
		}
		for range 2 {
			if _, err := share.BackfillLabels(ctx, pool, 1); err != nil {
				t.Fatal(err)
			}
		}
		var label string
		if err := pool.QueryRow(ctx, `SELECT admin_label FROM shares WHERE id=$1`, id).Scan(&label); err != nil || label != "**Plain authored title**" {
			t.Fatalf("label=%q err=%v", label, err)
		}
		if snapshot() != before {
			t.Fatal("migration/backfill changed existing data")
		}
		for _, label := range []string{"", strings.Repeat("界", 81)} {
			if _, err := pool.Exec(ctx, `UPDATE shares SET admin_label=$2 WHERE id=$1`, id, label); err == nil {
				t.Fatalf("accepted invalid label %q", label)
			}
		}
		if err := migrations.Run(ctx, pool, migrations.Down, 3); err != nil {
			t.Fatal(err)
		}
		assertColumnCount(t, pool, "admin_label", 0)
		if n := testdb.Count(t, pool, `SELECT count(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname='shares_pending_admin_labels_idx'`); n != 0 {
			t.Fatal("pending index not removed")
		}
		if snapshot() != before {
			t.Fatal("rollback changed legacy data")
		}
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 3); err != nil {
		t.Fatal(err)
	}
	if _, err := share.BackfillLabels(ctx, pool, 1); err != nil {
		t.Fatal(err)
	}
}
