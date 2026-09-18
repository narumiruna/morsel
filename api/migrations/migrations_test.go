package migrations_test

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/api/internal/testdb"
	"github.com/narumiruna/morsel/api/migrations"
)

func TestMigrationsUpDownUpAndIdempotence(t *testing.T) {
	pool := testdb.Open(t)
	ctx := context.Background()
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatalf("second up: %v", err)
	}

	assertColumnCount(t, pool, "telegram_instant_view", 1)
	assertColumnCount(t, pool, "preview_image", 1)
	assertColumnCount(t, pool, "preview_locale", 1)
	if _, err := pool.Exec(ctx, `INSERT INTO shares (id, token_hash, content, telegram_instant_view) VALUES ($1, $2, 'invalid', true)`, uuid.New(), bytes.Repeat([]byte{9}, 32)); err == nil {
		t.Fatal("expected Instant View constraint failure")
	}
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatalf("down Open Graph metadata migration: %v", err)
	}
	assertColumnCount(t, pool, "preview_image", 0)
	assertColumnCount(t, pool, "preview_locale", 0)
	assertColumnCount(t, pool, "telegram_instant_view", 1)

	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatalf("down Instant View migration: %v", err)
	}
	assertColumnCount(t, pool, "telegram_instant_view", 0)

	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatalf("down preview metadata migration: %v", err)
	}
	assertColumnCount(t, pool, "preview_enabled", 1)
	assertColumnCount(t, pool, "preview_title", 0)
	legacyID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO shares (id, token_hash, content, preview_enabled) VALUES ($1, $2, 'legacy', true)`, legacyID, bytes.Repeat([]byte{1}, 32)); err != nil {
		t.Fatalf("insert legacy preview: %v", err)
	}

	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatalf("reapply metadata migration: %v", err)
	}
	assertColumnCount(t, pool, "preview_enabled", 0)
	assertColumnCount(t, pool, "preview_title", 1)
	assertColumnCount(t, pool, "telegram_instant_view", 1)
	assertColumnCount(t, pool, "preview_image", 1)
	assertColumnCount(t, pool, "preview_locale", 1)
	var title, description string
	if err := pool.QueryRow(ctx, "SELECT preview_title, preview_description FROM shares WHERE id=$1", legacyID).Scan(&title, &description); err != nil {
		t.Fatal(err)
	}
	if title != "Morsel" || description != "Shared with Morsel." {
		t.Fatalf("legacy backfill title=%q description=%q", title, description)
	}

	invalidMetadata := []struct {
		name        string
		title       any
		description any
	}{
		{name: "unpaired", title: "title", description: nil},
		{name: "blank title", title: " ", description: "description"},
		{name: "padded description", title: "title", description: " description "},
		{name: "long title", title: strings.Repeat("界", 81), description: "description"},
		{name: "long description", title: "title", description: strings.Repeat("界", 201)},
	}
	for index, test := range invalidMetadata {
		t.Run(test.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `INSERT INTO shares (id, token_hash, content, preview_title, preview_description) VALUES ($1, $2, 'invalid', $3, $4)`, uuid.New(), bytes.Repeat([]byte{byte(index + 2)}, 32), test.title, test.description)
			if err == nil {
				t.Fatal("expected preview metadata constraint failure")
			}
		})
	}

	invalidOpenGraph := []struct {
		name   string
		title  any
		detail any
		image  any
		locale any
	}{
		{name: "relative image", title: "title", detail: "description", image: "/preview.png"},
		{name: "padded image", title: "title", detail: "description", image: " https://example.com/preview.png "},
		{name: "invalid locale", title: "title", detail: "description", locale: "zh-tw"},
		{name: "image without preview", image: "https://example.com/preview.png"},
		{name: "locale without preview", locale: "zh_TW"},
	}
	for index, test := range invalidOpenGraph {
		t.Run(test.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `INSERT INTO shares
				(id, token_hash, content, preview_title, preview_description, preview_image, preview_locale)
				VALUES ($1, $2, 'invalid', $3, $4, $5, $6)`,
				uuid.New(), bytes.Repeat([]byte{byte(index + 20)}, 32), test.title, test.detail, test.image, test.locale)
			if err == nil {
				t.Fatal("expected optional Open Graph metadata constraint failure")
			}
		})
	}

	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatalf("second down Open Graph metadata migration: %v", err)
	}
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatalf("second down Instant View migration: %v", err)
	}
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatalf("second down preview metadata migration: %v", err)
	}
	var enabled bool
	if err := pool.QueryRow(ctx, "SELECT preview_enabled FROM shares WHERE id=$1", legacyID).Scan(&enabled); err != nil || !enabled {
		t.Fatalf("restored preview_enabled=%t err=%v", enabled, err)
	}
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatalf("down boolean preview migration: %v", err)
	}
	assertColumnCount(t, pool, "preview_enabled", 0)
	if err := migrations.Run(ctx, pool, migrations.Down, 1); err != nil {
		t.Fatalf("down shares migration: %v", err)
	}
	var table *string
	if err := pool.QueryRow(ctx, "SELECT to_regclass('shares')::text").Scan(&table); err != nil {
		t.Fatal(err)
	}
	if table != nil {
		t.Fatalf("shares still exists as %q", *table)
	}
	if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
		t.Fatalf("reapply all migrations: %v", err)
	}
	if err := pool.QueryRow(ctx, "SELECT to_regclass('shares')::text").Scan(&table); err != nil || table == nil {
		t.Fatalf("shares missing after reapply: table=%v err=%v", table, err)
	}
}

func assertColumnCount(t *testing.T, pool *pgxpool.Pool, name string, want int) {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'shares' AND column_name = $1`, name).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("column %s count=%d want=%d", name, count, want)
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
