package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/api/migrations"
)

func TestDatabaseConnectionOverridesEveryDatabaseAlias(t *testing.T) {
	const target = "morsel_auth_e2e_0123456789abcdef01234567"
	cases := []string{
		"postgres://operator:secret@localhost/production?sslmode=disable",
		"postgres://operator:secret@localhost/production?database=admin&sslmode=disable",
		"postgresql://operator:secret@localhost/production?dbname=admin&database=other&database=another",
		"postgres://operator:secret@localhost/production?dbname=admin&dbname=other",
		"host=localhost user=operator password=secret dbname=production",
		"host=localhost user=operator password='secret with spaces' database=production dbname=other",
		"host=localhost user=operator dbname=production dbname=other",
	}
	for index, raw := range cases {
		derived, err := databaseConnection(raw, target)
		if err != nil {
			t.Fatalf("derive case %d failed", index)
		}
		cfg, err := pgx.ParseConfig(derived)
		if err != nil || cfg.Database != target {
			t.Fatalf("case %d did not select disposable database", index)
		}
		if cfg.User != "operator" {
			t.Fatalf("case %d changed connection user", index)
		}
	}
}

func TestDatabaseAliasCannotMigrateAdministratorDatabase(t *testing.T) {
	raw := os.Getenv("MORSEL_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("MORSEL_TEST_DATABASE_URL is required for database isolation integration test")
	}
	input, err := url.Parse(raw)
	if err != nil || (input.Scheme != "postgres" && input.Scheme != "postgresql") {
		t.Skip("PostgreSQL URL is required for the URL query alias integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	root, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatal("connect test administrator")
	}
	defer root.Close(context.Background())
	newDatabase := func() string {
		t.Helper()
		var entropy [12]byte
		if _, err := rand.Read(entropy[:]); err != nil {
			t.Fatal("generate isolated name")
		}
		name := "morsel_auth_e2e_" + hex.EncodeToString(entropy[:])
		if _, err := root.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" TEMPLATE template0"); err != nil {
			t.Fatal("create disposable database")
		}
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			conn, err := pgx.Connect(cleanup, raw)
			if err != nil {
				t.Error("connect for disposable database cleanup")
				return
			}
			defer conn.Close(cleanup)
			if _, err := conn.Exec(cleanup, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
				t.Error("drop disposable database")
			}
		})
		return name
	}
	// Even the simulated administrator database is disposable. Never create
	// sentinel tables or apply migrations in the operator-supplied database.
	adminName, targetName := newDatabase(), newDatabase()
	adminURL, err := databaseConnection(raw, adminName)
	if err != nil {
		t.Fatal("derive simulated administrator connection")
	}
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal("connect simulated administrator")
	}
	defer admin.Close(context.Background())
	if _, err := admin.Exec(ctx, `CREATE TABLE harness_sentinel(value text); INSERT INTO harness_sentinel VALUES('unchanged')`); err != nil {
		t.Fatal("create administrator sentinel")
	}
	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal("parse administrator connection")
	}
	query := u.Query()
	query.Set("database", adminName)
	query.Set("dbname", adminName)
	u.RawQuery = query.Encode()
	targetURL, err := databaseConnection(u.String(), targetName)
	if err != nil {
		t.Fatal("derive target with administrator query aliases")
	}
	pool, err := pgxpool.New(ctx, targetURL)
	if err != nil {
		t.Fatal("configure target database")
	}
	defer pool.Close()
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatal("migrate target database")
	}
	var sentinel string
	if err := admin.QueryRow(ctx, `SELECT value FROM harness_sentinel`).Scan(&sentinel); err != nil || sentinel != "unchanged" {
		t.Fatal("administrator sentinel changed")
	}
	var migrationCount int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='schema_migrations'`).Scan(&migrationCount); err != nil || migrationCount != 0 {
		t.Fatal("target migrations touched administrator database")
	}
	t.Setenv("MORSEL_DATABASE_URL", targetURL)
	if err := run(ctx, []string{"seed-legacy-share"}); err != nil {
		t.Fatal("seed legacy fixture in disposable target")
	}
	var content string
	if err := pool.QueryRow(ctx, `SELECT content FROM shares WHERE id='00000000-0000-4000-8000-000000000001'`).Scan(&content); err != nil || content != "# Legacy before account" {
		t.Fatal("legacy fixture missing")
	}
	var label string
	if err := pool.QueryRow(ctx, `SELECT admin_label FROM shares WHERE id='00000000-0000-4000-8000-000000000001'`).Scan(&label); err != nil || label != "Legacy before account" {
		t.Fatal("legacy fixture backfill missing")
	}
	var accountCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM accounts`).Scan(&accountCount); err != nil || accountCount != 0 {
		t.Fatal("legacy fixture requires an account")
	}
	var targetMigrations int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&targetMigrations); err != nil || targetMigrations != 8 {
		t.Fatal("target database was not fully migrated")
	}
}

func TestRejectUnsafeDatabaseNames(t *testing.T) {
	// A valid-looking production connection must never be reached for these names.
	t.Setenv("MORSEL_TEST_DATABASE_URL", "postgres://operator:secret@127.0.0.1:1/production?connect_timeout=1")
	for _, command := range []string{"database-create", "database-drop"} {
		for _, name := range []string{
			"production", "morsel_test", "postgres", "",
			"morsel_auth_e2e_", "morsel_auth_e2e_0123456789abcdef0123456",
			"morsel_auth_e2e_0123456789abcdef012345678",
			"morsel_auth_e2e_0123456789ABCDEF01234567",
			`morsel_auth_e2e_0123456789abcdef01234567"; DROP DATABASE production;--`,
			"morsel_auth_e2e_0123456789abcdef01234567\n",
		} {
			t.Run(command+"/"+name, func(t *testing.T) {
				err := run(context.Background(), []string{command, name})
				if err == nil || err.Error() != "invalid disposable database name" {
					t.Fatal("unsafe name did not fail before database connection")
				}
			})
		}
	}
}

func TestMutationRequiresDisposableDatabase(t *testing.T) {
	for _, command := range []string{"expire-sessions", "expire-verification", "assert-no-secret", "seed-legacy-share"} {
		for _, database := range []string{"production", "postgres", "morsel_test", "morsel_auth_e2e_invalid"} {
			t.Run(command+"/"+database, func(t *testing.T) {
				t.Setenv("MORSEL_DATABASE_URL", "postgres://operator:secret@127.0.0.1:1/"+database+"?connect_timeout=1")
				err := run(context.Background(), []string{command})
				if err == nil || err.Error() != "operation requires disposable database" {
					t.Fatal("non-test database did not fail before database connection")
				}
			})
		}
	}
}

func TestRejectUnknownCommandsAndArguments(t *testing.T) {
	for _, args := range [][]string{nil, {"unknown"}, {"database-drop"}, {"expire-sessions", "extra"}, {"expire-verification", "extra"}, {"assert-no-secret", "extra"}, {"seed-legacy-share", "extra"}} {
		if err := run(context.Background(), args); err == nil {
			t.Fatal("invalid command accepted")
		}
	}
}
