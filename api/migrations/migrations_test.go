package migrations_test

import (
	"context"
	"strings"
	"testing"

	"github.com/narumiruna/morsel/api/internal/testdb"
	"github.com/narumiruna/morsel/api/migrations"
)

func TestMigrationsUpDownUpAndIdempotence(t *testing.T) {
	pool := testdb.Open(t)
	ctx := context.Background()
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatalf("second up: %v", err)
	}
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatalf("down: %v", err)
	}
	var table *string
	if err := pool.QueryRow(ctx, "SELECT to_regclass('shares')::text").Scan(&table); err != nil {
		t.Fatal(err)
	}
	if table != nil {
		t.Fatalf("shares still exists as %q", *table)
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatalf("reapply: %v", err)
	}
	if err := pool.QueryRow(ctx, "SELECT to_regclass('shares')::text").Scan(&table); err != nil || table == nil {
		t.Fatalf("shares missing after reapply: table=%v err=%v", table, err)
	}
}

func TestMigrationsRejectDirtyAndUnknownVersions(t *testing.T) {
	pool := testdb.Open(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "INSERT INTO schema_migrations(version, dirty) VALUES (999, true)"); err != nil {
		t.Fatal(err)
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err == nil || !strings.Contains(err.Error(), "dirty") {
		t.Fatalf("expected dirty migration error, got %v", err)
	}
	if _, err := pool.Exec(ctx, "UPDATE schema_migrations SET dirty=false WHERE version=999"); err != nil {
		t.Fatal(err)
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("expected unknown migration error, got %v", err)
	}
}
