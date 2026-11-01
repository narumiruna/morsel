package migrations_test

import (
	"reflect"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
	"github.com/narumiruna/morsel/packages/server/migrations"
)

func oauthMigrationTables(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(t.Context(), `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, name)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return tables
}

// Include every version-12 table, all columns (including account roles), the
// existing migration history, and the registration-order sequence.
func oauthLegacySnapshot(t *testing.T, pool *pgxpool.Pool, tables []string) map[string]string {
	t.Helper()
	snapshot := make(map[string]string)
	for _, table := range tables {
		query := `SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]')::text FROM ` + pgx.Identifier{table}.Sanitize() + ` r`
		if table == "schema_migrations" {
			query += ` WHERE version<=12`
		}
		var data string
		if err := pool.QueryRow(t.Context(), query).Scan(&data); err != nil {
			t.Fatal(err)
		}
		snapshot[table] = data
	}
	for name, query := range map[string]string{
		"columns":     `SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position),'[]')::text FROM information_schema.columns c WHERE table_schema=current_schema() AND table_name=ANY($1)`,
		"indexes":     `SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY tablename,indexname),'[]')::text FROM pg_indexes i WHERE schemaname=current_schema() AND tablename=ANY($1)`,
		"constraints": `SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname),'[]')::text FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1)`,
	} {
		var data string
		if err := pool.QueryRow(t.Context(), query, tables).Scan(&data); err != nil {
			t.Fatal(err)
		}
		snapshot[name] = data
	}
	var sequence string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_array(last_value,log_cnt,is_called)::text FROM auth_event_order`).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	snapshot["auth_event_order"] = sequence
	return snapshot
}

func TestOAuthMigrationUpDownUpPreservesAllLegacyState(t *testing.T) {
	pool := testdb.OpenVersion(t, 12)
	ctx := t.Context()
	owners := []uuid.UUID{testdb.Account(t, pool), testdb.Account(t, pool)}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET role='admin',display_name='Administrator' WHERE id=$1`, owners[0]); err != nil {
		t.Fatal(err)
	}
	for _, id := range owners {
		for _, query := range []string{
			`INSERT INTO shares(id,account_id,token_hash,content,admin_label,created_at,expires_at,max_views,view_count,revoked_at,preview_title,preview_description,preview_image,preview_locale,link_token,link_ciphertext) VALUES($1,$1,sha256(($1::uuid)::text::bytea),'# Retained','Label','2020-01-01Z','2030-01-01Z',7,2,'2020-02-01Z','Title','Description','https://example.com/preview.png','en_US','retained',decode('010203','hex'))`,
			`INSERT INTO passkey_credentials(id,account_id,name,credential) VALUES(($1::uuid)::text,$1,'Primary','{"fixture":true}')`,
			`INSERT INTO api_keys(id,account_id,name,prefix,token_hash) VALUES($1,$1,'Client','msk_fixture',sha256(($1::uuid)::text::bytea))`,
			`INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at) VALUES(sha256(($1::uuid)::text::bytea),$1,1,'csrf',clock_timestamp()+interval '1 day')`,
			`INSERT INTO auth_grants(token_hash,kind,account_id,generation,expires_at) VALUES(sha256(($1::uuid)::text::bytea),'recover',$1,1,clock_timestamp()+interval '1 hour')`,
			`INSERT INTO auth_flows(token_hash,kind,account_id,generation,session_hash,name,session_data,expires_at) VALUES(sha256(($1::uuid)::text::bytea),'verify',$1,1,sha256(($1::uuid)::text::bytea),'Passkey','{"fixture":true}',clock_timestamp()+interval '10 minutes')`,
		} {
			if _, err := pool.Exec(ctx, query, id); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_grants(token_hash,kind,expires_at) VALUES(sha256('invitation'::bytea),'invite',clock_timestamp()+interval '1 hour'); INSERT INTO auth_flows(token_hash,kind,name,session_data,expires_at) VALUES(sha256('login'::bytea),'login','Passkey','{}',clock_timestamp()+interval '10 minutes')`); err != nil {
		t.Fatal(err)
	}
	legacyTables := oauthMigrationTables(t, pool)
	before := oauthLegacySnapshot(t, pool, legacyTables)
	oauthTables := []string{"oauth_clients", "oauth_grants", "oauth_requests", "oauth_tokens"}
	withOAuth := append(slices.Clone(legacyTables), oauthTables...)
	slices.Sort(withOAuth)
	for _, direction := range []migrations.Direction{migrations.Up, migrations.Down, migrations.Up} {
		if err := migrations.Run(ctx, pool, direction, 1); err != nil {
			t.Fatal(err)
		}
		if got := oauthLegacySnapshot(t, pool, legacyTables); !reflect.DeepEqual(got, before) {
			for name, want := range before {
				if got[name] != want {
					t.Errorf("OAuth %s changed legacy %s", direction, name)
				}
			}
			t.FailNow()
		}
		wantTables := withOAuth
		if direction == migrations.Down {
			wantTables = legacyTables
			assertMigrationState(t, pool, 12)
		} else {
			assertMigrationState(t, pool, 13)
		}
		if got := oauthMigrationTables(t, pool); !reflect.DeepEqual(got, wantTables) {
			t.Fatalf("tables=%v want=%v", got, wantTables)
		}
		if direction == migrations.Up {
			for _, table := range oauthTables {
				if testdb.Count(t, pool, `SELECT count(*) FROM `+pgx.Identifier{table}.Sanitize()) != 0 {
					t.Fatalf("%s retained OAuth credentials after reapplication", table)
				}
			}
			client, grant := uuid.New(), uuid.New()
			if _, err := pool.Exec(ctx, `INSERT INTO oauth_clients(id,name,redirect_uris,expires_at) VALUES($1,'Native','["http://127.0.0.1:1234/callback"]',clock_timestamp()+interval '90 days')`, client); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO oauth_requests(handle_hash,client_id,form,account_id,generation,session_hash,expires_at) VALUES(sha256('request'::bytea),$1,'{}',$2,1,sha256('session'::bytea),clock_timestamp()+interval '10 minutes')`, client, owners[0]); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO oauth_grants(id,account_id,generation,client_id,issuer,resource,scope,expires_at) VALUES($1,$2,1,$3,'https://morsel.example','https://morsel.example/mcp','mcp:shares offline_access',clock_timestamp()+interval '30 days')`, grant, owners[0], client); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO oauth_tokens(signature,kind,grant_id,request_data,expires_at) SELECT encode(sha256(kind::bytea),'hex'),kind,$1,'{}',clock_timestamp()+interval '1 minute' FROM unnest(ARRAY['code','pkce','access','refresh']) AS kind`, grant); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatalf("idempotent up: %v", err)
	}
	if got := oauthLegacySnapshot(t, pool, legacyTables); !reflect.DeepEqual(got, before) {
		t.Fatal("repeated OAuth up changed legacy state")
	}
}
