package migrations_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
	"github.com/narumiruna/morsel/packages/server/migrations"
)

func TestAccountRoleBootstrap(t *testing.T) {
	const first = "00000000-0000-4000-8000-000000000001"
	const second = "00000000-0000-4000-8000-000000000002"
	const third = "00000000-0000-4000-8000-000000000003"
	for _, test := range []struct {
		name  string
		ids   []string
		dates []string
		want  string
	}{
		{"empty", nil, nil, ""},
		{"one", []string{second}, []string{"2020-01-01Z"}, second},
		{"oldest not smallest UUID", []string{first, third, second}, []string{"2021-01-01Z", "2019-01-01Z", "2020-01-01Z"}, third},
		{"timestamp tie", []string{third, second, first}, []string{"2020-01-01Z", "2020-01-01Z", "2020-01-01Z"}, first},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := testdb.OpenVersion(t, 11)
			ctx := t.Context()
			for i, id := range test.ids {
				if _, err := pool.Exec(ctx, `INSERT INTO accounts(id,created_at) VALUES($1,$2::timestamptz)`, uuid.MustParse(id), test.dates[i]); err != nil {
					t.Fatal(err)
				}
			}
			var selected string
			if err := pool.QueryRow(ctx, `SELECT COALESCE((SELECT id::text FROM accounts ORDER BY created_at,id LIMIT 1),'')`).Scan(&selected); err != nil {
				t.Fatal(err)
			}
			if selected != test.want {
				t.Fatalf("preflight selected %s want %s", selected, test.want)
			}
			t.Logf("ORDER BY created_at,id selected %q", selected)
			if err := migrations.Run(ctx, pool, migrations.Up, 1); err != nil {
				t.Fatal(err)
			}
			assertMigrationState(t, pool, 12)
			wantAdmins := int64(1)
			if test.want == "" {
				wantAdmins = 0
			}
			if n := testdb.Count(t, pool, `SELECT count(*) FROM accounts WHERE role='admin'`); n != wantAdmins {
				t.Fatalf("admins=%d", n)
			}
			if test.want != "" && testdb.Count(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND role='admin'`, uuid.MustParse(test.want)) != 1 {
				t.Fatal("wrong legacy admin")
			}
			if n := testdb.Count(t, pool, `SELECT count(*) FROM accounts WHERE role='user'`); n != int64(len(test.ids))-wantAdmins {
				t.Fatalf("users=%d", n)
			}
			// Repeated up must not promote an account after role loss or later setup.
			if _, err := pool.Exec(ctx, `UPDATE accounts SET role='user'`); err != nil {
				t.Fatal(err)
			}
			testdb.Account(t, pool)
			if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
				t.Fatal(err)
			}
			if testdb.Count(t, pool, `SELECT count(*) FROM accounts WHERE role<>'user'`) != 0 {
				t.Fatal("repeated up reassigned roles")
			}
		})
	}
}

func roleDataSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var snapshot string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_object(
		'accounts',(SELECT jsonb_agg(to_jsonb(a)-'role' ORDER BY id) FROM accounts a),
		'shares',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM shares s),
		'passkeys',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM passkey_credentials p),
		'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM api_keys k),
		'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM auth_sessions s),
		'flows',(SELECT jsonb_agg(to_jsonb(f) ORDER BY token_hash) FROM auth_flows f),
		'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY token_hash) FROM auth_grants g)
	)::text`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestAccountRoleDownUpPreservesIsolationAndAuthentication(t *testing.T) {
	pool := testdb.OpenVersion(t, 11)
	ctx := t.Context()
	a, b := testdb.Account(t, pool), testdb.Account(t, pool)
	for _, id := range []uuid.UUID{a, b} {
		for _, query := range []string{
			`INSERT INTO shares(id,account_id,token_hash,content,link_token) VALUES($1,$1,sha256(($1::uuid)::text::bytea),'private','retained')`,
			`INSERT INTO passkey_credentials(id,account_id,name,credential) VALUES(($1::uuid)::text,$1,'Primary','{}')`,
			`INSERT INTO api_keys(id,account_id,name,prefix,token_hash) VALUES($1,$1,'Client','msk_fixture',sha256(($1::uuid)::text::bytea))`,
			`INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at) VALUES(sha256(($1::uuid)::text::bytea),$1,1,'csrf',clock_timestamp()+interval '1 day')`,
			`INSERT INTO auth_grants(token_hash,kind,account_id,generation,expires_at) VALUES(sha256(($1::uuid)::text::bytea),'recover',$1,1,clock_timestamp()+interval '1 hour')`,
			`INSERT INTO auth_flows(token_hash,kind,name,session_data,expires_at) VALUES(sha256(($1::uuid)::text::bytea),'login','Passkey','{}',clock_timestamp()+interval '10 minutes')`,
		} {
			if _, err := pool.Exec(ctx, query, id); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_grants(token_hash,kind,expires_at) VALUES(sha256('invitation'::bytea),'invite',clock_timestamp()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	before := roleDataSnapshot(t, pool)
	for _, direction := range []migrations.Direction{migrations.Up, migrations.Down, migrations.Up} {
		if err := migrations.Run(ctx, pool, direction, 1); err != nil {
			t.Fatal(err)
		}
		if roleDataSnapshot(t, pool) != before {
			t.Fatal("role migration changed ownership, capabilities, or authentication")
		}
	}
	for _, role := range []any{nil, "owner", "Admin", "", "admin ", "superuser"} {
		if _, err := pool.Exec(ctx, `UPDATE accounts SET role=$2 WHERE id=$1`, a, role); err == nil {
			t.Fatalf("accepted role %v", role)
		}
	}
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatal(err)
	}
	assertMigrationState(t, pool, 11)
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err == nil {
		t.Fatal("migration 11 isolation guard lost")
	}
	assertMigrationState(t, pool, 11)
}
