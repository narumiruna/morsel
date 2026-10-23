package main

import (
	"context"
	"testing"

	"github.com/narumiruna/morsel/api/internal/testdb"
	"github.com/narumiruna/morsel/api/migrations"
)

func TestMigrateRunsResumableLabelsOnlyForApplicableSchema(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	if err := migrate(ctx, pool, migrations.Down, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content)
  SELECT md5(n::text)::uuid,sha256(convert_to(n::text,'UTF8')),'# **Legacy** '||n FROM generate_series(1,35) n`); err != nil {
		t.Fatal(err)
	}
	// Normal up applies the label schema and finishes all pending batches.
	if err := migrate(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatal(err)
	}
	if n := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE admin_label IS NOT NULL`); n != 35 {
		t.Fatalf("normal up did not finish all batches: %d", n)
	}
	if err := migrate(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, migrations.Down, 2); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatal(err)
	}
	// Target version seven: do not query the version-eight label column.
	if err := migrate(ctx, pool, migrations.Up, 1); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, migrations.Up, 1); err != nil {
		t.Fatal(err)
	}
	if n := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE admin_label LIKE 'Legacy %'`); n != 35 {
		t.Fatalf("recovery labels=%d", n)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := migrate(cancelled, pool, migrations.Up, 0); err == nil {
		t.Fatal("cancelled migration succeeded")
	}
}
