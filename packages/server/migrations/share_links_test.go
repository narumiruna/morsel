package migrations_test

import (
	"bytes"
	"testing"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
	"github.com/narumiruna/morsel/packages/server/migrations"
)

func TestStoredLinksMigrationPreservesLegacyCapabilities(t *testing.T) {
	pool := testdb.OpenVersion(t, 8)
	ctx := t.Context()
	id := uuid.New()
	_, hash, _ := (share.TokenGenerator{}).Generate()
	if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content,admin_label) VALUES($1,$2,'# Legacy','Legacy')`, id, hash[:]); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		var value string
		if err := pool.QueryRow(ctx, `SELECT (to_jsonb(shares)-'link_ciphertext')::text FROM shares WHERE id=$1`, id).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot()
	for range 2 {
		if err := migrations.Run(ctx, pool, migrations.Up, 1); err != nil {
			t.Fatal(err)
		}
		if snapshot() != before {
			t.Fatal("migration changed legacy share")
		}
		var encrypted []byte
		if err := pool.QueryRow(ctx, "SELECT link_ciphertext FROM shares WHERE id=$1", id).Scan(&encrypted); err != nil || encrypted != nil {
			t.Fatal("legacy link must remain unavailable")
		}
		encrypted = bytes.Repeat([]byte{1}, 64)
		if _, err := pool.Exec(ctx, "UPDATE shares SET link_ciphertext=$2 WHERE id=$1", id, encrypted); err != nil {
			t.Fatal(err)
		}
		if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
			t.Fatal(err)
		}
		assertColumnCount(t, pool, "link_ciphertext", 0)
		if snapshot() != before {
			t.Fatal("rollback changed legacy share")
		}
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 2); err != nil {
		t.Fatal(err)
	}
	// Public authorization still uses the original hash, never a replacement token.
	if _, err := share.NewPostgresRepository(pool).Consume(ctx, hash); err != nil {
		t.Fatal(err)
	}
}
