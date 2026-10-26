package migrations_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/narumiruna/morsel/api/internal/testdb"
	"github.com/narumiruna/morsel/api/migrations"
)

func TestMultiAccountUpgradePreconditionsAreRetryable(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		accounts int
		shares   bool
		rejected bool
	}{
		{"empty", 0, false, false},
		{"single empty owner", 1, false, false},
		{"legacy shares need setup", 0, true, true},
		{"ambiguous owners", 2, false, true},
		{"ambiguous shares", 2, true, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			pool := testdb.OpenVersion(t, 10)
			ctx := t.Context()
			for range scenario.accounts {
				testdb.Account(t, pool)
			}
			if scenario.shares {
				if _, err := pool.Exec(ctx, "INSERT INTO shares(id,token_hash,content) VALUES($1,$2,'legacy')", uuid.New(), bytes.Repeat([]byte{1}, 32)); err != nil {
					t.Fatal(err)
				}
			}
			err := migrations.Run(ctx, pool, migrations.Up, 0)
			if scenario.rejected {
				if err == nil {
					t.Fatal("unsafe ownership upgrade succeeded")
				}
				assertMigrationState(t, pool, 10)
				assertColumnCount(t, pool, "account_id", 0)
				if scenario.accounts == 0 {
					testdb.Account(t, pool)
					if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
						t.Fatalf("retry after owner setup: %v", err)
					}
					assertMigrationState(t, pool, 11)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				assertMigrationState(t, pool, 11)
			}
		})
	}
}

func TestMultiAccountUpgradePreservesLegacyDataAndAuthentication(t *testing.T) {
	pool := testdb.OpenVersion(t, 10)
	ctx := t.Context()
	owner := testdb.Account(t, pool)
	id := uuid.New()
	token, hash, err := (share.TokenGenerator{}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shares
		(id,token_hash,content,admin_label,created_at,expires_at,max_views,view_count,revoked_at,
		preview_title,preview_description,preview_image,preview_locale,link_token,link_ciphertext)
		VALUES($1,$2,'# Legacy unchanged','Legacy','2020-01-01Z','2030-01-01Z',7,2,'2020-02-01Z',
		'Legacy','Description','https://example.com/a.png','en_US',$3,$4)`, id, hash[:], token, []byte("retained ciphertext")); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO passkey_credentials(id,account_id,name,credential) VALUES('fixture',$1,'Primary','{}');
	`, owner); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at) VALUES(decode(repeat('01',32),'hex'),$1,1,'csrf',clock_timestamp()+interval '1 day')`,
		`INSERT INTO auth_grants(token_hash,kind,account_id,generation,expires_at) VALUES(decode(repeat('02',32),'hex'),'recover',$1,1,clock_timestamp()+interval '1 hour')`,
		`INSERT INTO auth_flows(token_hash,kind,account_id,generation,name,session_data,expires_at) VALUES(decode(repeat('03',32),'hex'),'login',$1,1,'Passkey','{}',clock_timestamp()+interval '10 minutes')`,
		`INSERT INTO api_keys(id,account_id,name,prefix,token_hash) VALUES('00000000-0000-4000-8000-000000000001',$1,'Client','msk_fixture',decode(repeat('04',32),'hex'))`,
	} {
		if _, err := pool.Exec(ctx, query, owner); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := func(table, exclude string) string {
		t.Helper()
		var value string
		if err := pool.QueryRow(ctx, "SELECT jsonb_agg(to_jsonb(r)-$1 ORDER BY to_jsonb(r)::text)::text FROM "+table+" r", exclude).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := map[string]string{}
	for table, exclude := range map[string]string{"shares": "account_id", "accounts": "display_name", "passkey_credentials": "registered_order", "api_keys": "", "auth_sessions": "", "auth_grants": ""} {
		before[table] = snapshot(table, exclude)
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatal(err)
	}
	for table, exclude := range map[string]string{"shares": "account_id", "accounts": "display_name", "passkey_credentials": "registered_order", "api_keys": "", "auth_sessions": "", "auth_grants": ""} {
		if snapshot(table, exclude) != before[table] {
			t.Fatalf("migration changed existing %s", table)
		}
	}
	if n := testdb.Count(t, pool, "SELECT count(*) FROM shares WHERE account_id=$1", owner); n != 1 {
		t.Fatal("legacy share not assigned to the sole owner")
	}
	if n := testdb.Count(t, pool, "SELECT count(*) FROM auth_flows"); n != 0 {
		t.Fatal("old ceremonies survived schema binding change")
	}
	if n := testdb.Count(t, pool, "SELECT count(*) FROM passkey_credentials WHERE registered_order>0"); n != 1 {
		t.Fatal("legacy credential lacks registration order")
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatal("repeated migration failed")
	}
}

func TestMultiAccountDowngradeRejectsUnsafeStateWithoutDirtying(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	a := testdb.Account(t, pool)
	b := testdb.Account(t, pool)
	if _, err := pool.Exec(ctx, `INSERT INTO passkey_credentials(id,account_id,name,credential) VALUES('retained',$1,'Primary','{}')`, a); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at) VALUES(decode(repeat('01',32),'hex'),$1,1,'csrf',clock_timestamp()+interval '1 day')`,
		`INSERT INTO auth_grants(token_hash,kind,account_id,generation,expires_at) VALUES(decode(repeat('02',32),'hex'),'recover',$1,1,clock_timestamp()+interval '1 hour')`,
		`INSERT INTO api_keys(id,account_id,name,prefix,token_hash) VALUES('00000000-0000-4000-8000-000000000002',$1,'Retained','msk_fixture',decode(repeat('03',32),'hex'))`,
	} {
		if _, err := pool.Exec(ctx, query, a); err != nil {
			t.Fatal(err)
		}
	}
	before := authenticationSnapshot(t, pool)
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err == nil || !strings.Contains(err.Error(), "multiple accounts") {
		t.Fatalf("unsafe downgrade: %v", err)
	}
	assertMigrationState(t, pool, 11)
	assertColumnCount(t, pool, "account_id", 1)
	if _, err := pool.Exec(ctx, "DELETE FROM accounts WHERE id=$1", b); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO auth_grants(token_hash,kind,expires_at) VALUES(decode(repeat('05',32),'hex'),'invite',clock_timestamp()+interval '1 hour')`,
		`INSERT INTO auth_flows(token_hash,kind,name,session_data,expires_at) VALUES(decode(repeat('06',32),'hex'),'login','Passkey','{}',clock_timestamp()+interval '10 minutes')`,
	} {
		if _, err := pool.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	id := uuid.New()
	if _, err := pool.Exec(ctx, "INSERT INTO shares(id,account_id,token_hash,content) VALUES($1,$2,$3,'retained')", id, a, bytes.Repeat([]byte{2}, 32)); err != nil {
		t.Fatal(err)
	}
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatal(err)
	}
	assertMigrationState(t, pool, 10)
	if authenticationSnapshot(t, pool) != before {
		t.Fatal("downgrade changed retained authentication records")
	}
	if n := testdb.Count(t, pool, "SELECT count(*) FROM auth_grants WHERE kind='invite'"); n != 0 {
		t.Fatal("new grant variants survived downgrade")
	}
	if n := testdb.Count(t, pool, "SELECT count(*) FROM auth_flows"); n != 0 {
		t.Fatal("unbound flows survived downgrade")
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatal(err)
	}
	if authenticationSnapshot(t, pool) != before {
		t.Fatal("down/up changed retained authentication records")
	}
	if n := testdb.Count(t, pool, "SELECT count(*) FROM shares WHERE id=$1 AND account_id=$2 AND content='retained'", id, a); n != 1 {
		t.Fatal("down/up lost ownership or content")
	}
}

func TestMultiAccountSchemaRequiresValidOwnershipAndBinding(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	a := testdb.Account(t, pool)
	for _, owner := range []any{nil, uuid.New()} {
		if _, err := pool.Exec(ctx, "INSERT INTO shares(id,account_id,token_hash,content) VALUES($1,$2,$3,'invalid')", uuid.New(), owner, bytes.Repeat([]byte{3}, 32)); err == nil {
			t.Fatal("accepted missing or orphaned owner")
		}
	}
	if _, err := pool.Exec(ctx, "INSERT INTO shares(id,account_id,token_hash,content) VALUES($1,$2,$3,'owned')", uuid.New(), a, bytes.Repeat([]byte{3}, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM accounts WHERE id=$1", a); err == nil {
		t.Fatal("account deletion removed owned shares")
	}
	for _, name := range []string{"", " ", " padded", "line\nbreak", strings.Repeat("界", 67)} {
		if _, err := pool.Exec(ctx, "UPDATE accounts SET display_name=$2 WHERE id=$1", a, name); err == nil {
			t.Fatalf("accepted invalid account name %q", name)
		}
	}
	for _, query := range []string{
		`INSERT INTO auth_flows(token_hash,kind,account_id,generation,name,session_data,expires_at) VALUES(decode(repeat('07',32),'hex'),'login',$1,1,'Passkey','{}',clock_timestamp()+interval '1 minute')`,
		`INSERT INTO auth_flows(token_hash,kind,name,session_data,expires_at) SELECT decode(repeat('08',32),'hex'),'verify','Passkey','{}',clock_timestamp()+interval '1 minute' WHERE $1::uuid IS NOT NULL`,
	} {
		if _, err := pool.Exec(ctx, query, a); err == nil {
			t.Fatal("accepted invalid flow account binding")
		}
	}
}

func TestMultiAccountUnusedSetupGrantSurvivesDownUp(t *testing.T) {
	pool := testdb.OpenVersion(t, 10)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `INSERT INTO auth_grants(token_hash,kind,expires_at) VALUES(decode(repeat('09',32),'hex'),'setup',clock_timestamp()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	before := authenticationSnapshot(t, pool)
	for _, direction := range []migrations.Direction{migrations.Up, migrations.Down, migrations.Up} {
		if err := migrations.Run(ctx, pool, direction, 1); err != nil {
			t.Fatal(err)
		}
		if authenticationSnapshot(t, pool) != before {
			t.Fatal("migration changed an unclaimed setup grant")
		}
	}
}

func authenticationSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var value string
	err := pool.QueryRow(t.Context(), `SELECT jsonb_build_object(
		'passkeys', (SELECT coalesce(jsonb_agg(to_jsonb(p)-'registered_order' ORDER BY id),'[]') FROM passkey_credentials p),
		'sessions', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY token_hash),'[]') FROM auth_sessions s),
		'keys', (SELECT coalesce(jsonb_agg(to_jsonb(k) ORDER BY id),'[]') FROM api_keys k),
		'grants', (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY token_hash),'[]') FROM auth_grants g WHERE kind <> 'invite')
	)::text`).Scan(&value)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func assertMigrationState(t *testing.T, pool *pgxpool.Pool, version int64) {
	t.Helper()
	if n := testdb.Count(t, pool, "SELECT coalesce(max(version),0) FROM schema_migrations"); n != version {
		t.Fatalf("migration version=%d want=%d", n, version)
	}
	if n := testdb.Count(t, pool, "SELECT count(*) FROM schema_migrations WHERE dirty"); n != 0 {
		t.Fatal("precondition failure dirtied migration metadata")
	}
}
