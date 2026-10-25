package migrations_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
	"github.com/narumiruna/morsel/api/migrations"
)

func TestShareHistoryIndexPreservesLegacyRows(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	if err := migrations.Run(ctx, pool, migrations.Down, 4); err != nil {
		t.Fatal(err)
	}
	assertAuthTables(t, pool, true)
	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO shares
		(id,token_hash,content,created_at,expires_at,max_views,view_count,revoked_at,preview_title,preview_description)
		VALUES ($1,$2,'legacy Markdown', '2020-01-01Z','2021-01-01Z',7,5,'2020-12-01Z','Legacy','Description')`, id, bytes.Repeat([]byte{19}, 32)); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		t.Helper()
		var data string
		if err := pool.QueryRow(ctx, `SELECT to_jsonb(shares)::text FROM shares WHERE id=$1`, id).Scan(&data); err != nil {
			t.Fatal(err)
		}
		return data
	}
	before := snapshot()
	for cycle := 0; cycle < 2; cycle++ {
		if err := migrations.Run(ctx, pool, migrations.Up, 1); err != nil {
			t.Fatal(err)
		}
		var definition string
		if err := pool.QueryRow(ctx, `SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='shares_created_at_id_idx'`).Scan(&definition); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(definition, "(created_at DESC, id DESC)") {
			t.Fatalf("unexpected index: %s", definition)
		}
		if snapshot() != before {
			t.Fatal("index migration changed a legacy row")
		}
		if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
			t.Fatal(err)
		}
		if n := testdb.Count(t, pool, `SELECT count(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname='shares_created_at_id_idx'`); n != 0 {
			t.Fatal("index still exists after down")
		}
		assertAuthTables(t, pool, true)
		if snapshot() != before {
			t.Fatal("index rollback changed a legacy row")
		}
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatal(err)
	}
}
