package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	if err := migrations.Run(ctx, pool, migrations.Up, 11); err != nil {
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
	const owner = "10000000-0000-4000-8000-000000000001"
	if err := run(ctx, []string{"seed-legacy-share", owner}); err == nil {
		t.Fatal("legacy fixture accepted an ownerless database")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts(id) VALUES($1)`, owner); err != nil {
		t.Fatal("create sole fixture owner")
	}
	// Test the old latest-version boundary explicitly before adding roles.
	if err := run(ctx, []string{"seed-legacy-share", owner}); err == nil {
		t.Fatal("legacy fixture accepted schema 11")
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 1); err != nil {
		t.Fatal("migrate role fixture to schema 12")
	}
	if _, err := pool.Exec(ctx, `WITH retained AS (INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at)
		VALUES(decode(repeat('dd',32),'hex'),$1,1,'retained-csrf',clock_timestamp()+interval '1 hour') RETURNING account_id)
		INSERT INTO api_keys(id,account_id,name,prefix,token_hash)
		VALUES('00000000-0000-4000-8000-000000000003',$1,'Retained client','msk_retained',decode(repeat('ee',32),'hex'))`, owner); err != nil {
		t.Fatal("create retained authorization fixture")
	}
	const snapshotSQL = `SELECT jsonb_build_object(
		'account', (SELECT to_jsonb(a) FROM accounts a WHERE id=$1),
		'sessions', (SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM auth_sessions s),
		'keys', (SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM api_keys k))::text`
	var before string
	if err := pool.QueryRow(ctx, snapshotSQL, owner).Scan(&before); err != nil {
		t.Fatal("snapshot authorization fixture")
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET role='user' WHERE id=$1`, owner); err != nil {
		t.Fatal("set sole user fixture")
	}
	if err := run(ctx, []string{"seed-legacy-share", owner}); err == nil {
		t.Fatal("legacy fixture would promote a sole user")
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET role='admin' WHERE id=$1`, owner); err != nil {
		t.Fatal("restore sole admin fixture")
	}
	if _, err := pool.Exec(ctx, `UPDATE schema_migrations SET dirty=true WHERE version=12`); err != nil {
		t.Fatal("set dirty fixture")
	}
	if err := run(ctx, []string{"seed-legacy-share", owner}); err == nil {
		t.Fatal("legacy fixture accepted dirty schema 12")
	}
	if _, err := pool.Exec(ctx, `UPDATE schema_migrations SET dirty=false WHERE version=12`); err != nil {
		t.Fatal("restore clean fixture")
	}
	if err := run(ctx, []string{"seed-legacy-share", "10000000-0000-4000-8000-000000000099"}); err == nil {
		t.Fatal("legacy fixture accepted a foreign owner")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_flows(token_hash,kind,name,session_data,expires_at)
		VALUES(decode(repeat('cc',32),'hex'),'login','','{}',clock_timestamp()+interval '1 hour')`); err != nil {
		t.Fatal("create active fixture ceremony")
	}
	if err := run(ctx, []string{"seed-legacy-share", owner}); err == nil {
		t.Fatal("legacy fixture accepted an active ceremony")
	}
	if _, err := pool.Exec(ctx, `DELETE FROM auth_flows`); err != nil {
		t.Fatal("remove fixture ceremony")
	}
	if err := run(ctx, []string{"seed-legacy-share", owner}); err != nil {
		t.Fatal("seed legacy fixture in disposable target")
	}
	var after string
	if err := pool.QueryRow(ctx, snapshotSQL, owner).Scan(&after); err != nil || after != before {
		t.Fatal("legacy transition changed admin role, account identity, session, or key")
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
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM accounts`).Scan(&accountCount); err != nil || accountCount != 1 {
		t.Fatal("legacy fixture did not preserve the sole owner")
	}
	var targetMigrations int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&targetMigrations); err != nil || targetMigrations != 12 {
		t.Fatal("target database was not fully migrated")
	}
	var actualOwner string
	if err := pool.QueryRow(ctx, `SELECT account_id FROM shares WHERE id='00000000-0000-4000-8000-000000000001'`).Scan(&actualOwner); err != nil || actualOwner != owner {
		t.Fatal("legacy share was not assigned to the sole owner")
	}
	// Grant helpers accept secrets only on stdin and select by hash. The
	// expiry mutation must not affect another independent invitation.
	withInput := func(command, token string) error {
		t.Helper()
		input, err := os.CreateTemp(t.TempDir(), "stdin-*")
		if err != nil {
			t.Fatal("create private helper input")
		}
		defer input.Close()
		if _, err := input.WriteString(token); err != nil {
			t.Fatal("write private helper input")
		}
		if _, err := input.Seek(0, 0); err != nil {
			t.Fatal("rewind private helper input")
		}
		previous := os.Stdin
		os.Stdin = input
		defer func() { os.Stdin = previous }()
		return run(ctx, []string{command})
	}
	const first = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	const independent = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
	for _, token := range []string{first, independent} {
		hash := sha256.Sum256([]byte(token))
		if _, err := pool.Exec(ctx, `INSERT INTO auth_grants(token_hash,kind,expires_at)
			VALUES($1,'invite',clock_timestamp()+interval '1 hour')`, hash[:]); err != nil {
			t.Fatal("seed hashed invitation fixture")
		}
		if err := withInput("assert-invitation", token); err != nil {
			t.Fatal("hashed invitation fixture not found")
		}
		if err := withInput("assert-no-secret", token); err != nil {
			t.Fatal("raw invitation fixture persisted")
		}
	}
	if err := withInput("expire-invitation", first); err != nil {
		t.Fatal("expire target invitation")
	}
	if err := withInput("assert-invitation", first); err == nil {
		t.Fatal("expired invitation remained valid")
	}
	if err := withInput("assert-invitation", independent); err != nil {
		t.Fatal("expiry affected independent invitation")
	}
	for _, command := range []string{"assert-invitation", "expire-invitation"} {
		for _, token := range []string{"too-short", first + "A", first[:42] + "/", first[:42] + "B"} {
			if err := withInput(command, token); err == nil {
				t.Fatal("grant helper accepted invalid input")
			}
		}
	}
	const other = "20000000-0000-4000-8000-000000000002"
	if _, err := pool.Exec(ctx, `INSERT INTO accounts(id) VALUES($1)`, other); err != nil {
		t.Fatal("create second fixture owner")
	}
	if err := run(ctx, []string{"seed-legacy-share", owner}); err == nil {
		t.Fatal("legacy fixture accepted multiple accounts")
	}
	if _, err := pool.Exec(ctx, `DELETE FROM auth_sessions`); err != nil {
		t.Fatal("remove retained session fixture")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at)
		VALUES(decode(repeat('aa',32),'hex'),$1,1,'csrf-a',clock_timestamp()+interval '1 hour'),
		(decode(repeat('bb',32),'hex'),$2,1,'csrf-b',clock_timestamp()+interval '1 hour')`, owner, other); err != nil {
		t.Fatal("create independent sessions")
	}
	if err := run(ctx, []string{"expire-verification", owner}); err != nil {
		t.Fatal("expire owner verification")
	}
	if err := run(ctx, []string{"expire-sessions", owner}); err != nil {
		t.Fatal("expire owner sessions")
	}
	var isolated bool
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT expires_at<clock_timestamp() AND verified_at=to_timestamp(0) FROM auth_sessions WHERE account_id=$1)
		AND (SELECT expires_at>clock_timestamp() AND verified_at>to_timestamp(0) FROM auth_sessions WHERE account_id=$2)`, owner, other).Scan(&isolated); err != nil || !isolated {
		t.Fatal("session expiry changed another account")
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
	for _, command := range []string{"expire-sessions", "expire-verification", "assert-no-secret", "assert-invitation", "expire-invitation", "seed-legacy-share"} {
		for _, database := range []string{"production", "postgres", "morsel_test", "morsel_auth_e2e_invalid"} {
			t.Run(command+"/"+database, func(t *testing.T) {
				t.Setenv("MORSEL_DATABASE_URL", "postgres://operator:secret@127.0.0.1:1/"+database+"?connect_timeout=1")
				args := []string{command}
				if command != "assert-no-secret" && command != "assert-invitation" && command != "expire-invitation" {
					args = append(args, "10000000-0000-4000-8000-000000000001")
				}
				err := run(context.Background(), args)
				if err == nil || err.Error() != "operation requires disposable database" {
					t.Fatal("non-test database did not fail before database connection")
				}
			})
		}
	}
}

func TestRejectUnknownCommandsAndArguments(t *testing.T) {
	for _, args := range [][]string{nil, {"unknown"}, {"database-drop"}, {"expire-sessions"}, {"expire-verification"}, {"seed-legacy-share"}, {"expire-sessions", "00000000-0000-0000-0000-000000000000"}, {"expire-sessions", "extra"}, {"expire-verification", "extra"}, {"assert-no-secret", "extra"}, {"assert-invitation", "extra"}, {"expire-invitation", "extra"}, {"seed-legacy-share", "extra"}} {
		if err := run(context.Background(), args); err == nil {
			t.Fatal("invalid command accepted")
		}
	}
}
