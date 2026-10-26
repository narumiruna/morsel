package migrations_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/narumiruna/morsel/api/internal/testdb"
	"github.com/narumiruna/morsel/api/migrations"
)

func TestPlaintextLinksMigrationPreservesExistingShares(t *testing.T) {
	pool := testdb.OpenVersion(t, 9)
	ctx := t.Context()
	id := uuid.New()
	token, hash, err := (share.TokenGenerator{}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	// Preserve old ciphertext for recovery without interpreting or discarding it.
	if _, err := pool.Exec(ctx, `INSERT INTO shares
		(id,token_hash,content,admin_label,max_views,view_count,link_ciphertext)
		VALUES($1,$2,'# Existing','Existing',7,2,$3)`, id, hash[:], []byte("legacy ciphertext")); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		t.Helper()
		var data string
		if err := pool.QueryRow(ctx, `SELECT (to_jsonb(shares)-'link_token')::text FROM shares WHERE id=$1`, id).Scan(&data); err != nil {
			t.Fatal(err)
		}
		return data
	}
	before := snapshot()
	for range 2 {
		if err := migrations.Run(ctx, pool, migrations.Up, 1); err != nil {
			t.Fatal(err)
		}
		if snapshot() != before {
			t.Fatal("migration changed existing share or ciphertext")
		}
		var stored *string
		if err := pool.QueryRow(ctx, "SELECT link_token FROM shares WHERE id=$1", id).Scan(&stored); err != nil || stored != nil {
			t.Fatal("migration must not invent a legacy token")
		}
		if _, err := pool.Exec(ctx, "UPDATE shares SET link_token=$2 WHERE id=$1", id, token); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, "SELECT link_token FROM shares WHERE id=$1", id).Scan(&stored); err != nil || stored == nil || *stored != token {
			t.Fatal("original token was not retained")
		}
		if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
			t.Fatal(err)
		}
		assertColumnCount(t, pool, "link_token", 0)
		assertColumnCount(t, pool, "link_ciphertext", 1)
		if snapshot() != before {
			t.Fatal("rollback changed existing share or ciphertext")
		}
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := share.NewPostgresRepository(pool).Consume(ctx, hash); err != nil {
		t.Fatal("migration changed public capability access")
	}
}
