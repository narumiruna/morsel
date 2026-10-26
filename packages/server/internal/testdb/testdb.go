package testdb

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/migrations"
)

func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return OpenVersion(t, 0)
}

// OpenVersion creates an isolated schema at the given version; zero means latest.
func OpenVersion(t *testing.T, version int) *pgxpool.Pool {
	t.Helper()
	if version < 0 {
		t.Fatal("test schema version must not be negative")
	}
	databaseURL := os.Getenv("MORSEL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("MORSEL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect to test database: %v", err)
	}
	schema := "test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		admin.Close()
		t.Fatalf("create test schema: %v", err)
	}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrations.Run(ctx, pool, migrations.Up, version); err != nil {
		pool.Close()
		_, _ = admin.Exec(ctx, `DROP SCHEMA "`+schema+`" CASCADE`)
		admin.Close()
		t.Fatalf("migrate test schema: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		if _, err := admin.Exec(context.Background(), `DROP SCHEMA "`+schema+`" CASCADE`); err != nil {
			t.Errorf("drop test schema: %v", err)
		}
		admin.Close()
	})
	return pool
}

// Account creates an account for an explicit share owner in a fixture.
func Account(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := pool.Exec(t.Context(), "INSERT INTO accounts(id) VALUES($1)", id); err != nil {
		t.Fatal(err)
	}
	return id
}

// AccountID requires a sole existing fixture account; it never chooses an owner.
func AccountID(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	if n := Count(t, pool, "SELECT count(*) FROM accounts"); n != 1 {
		t.Fatalf("fixture requires exactly one account, got %d", n)
	}
	var id uuid.UUID
	if err := pool.QueryRow(t.Context(), "SELECT id FROM accounts").Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func Count(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatalf("query count: %v", err)
	}
	return count
}
