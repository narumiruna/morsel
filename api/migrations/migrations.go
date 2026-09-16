package migrations

import (
	"cmp"
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed *.sql
var files embed.FS

const advisoryLockID int64 = 0x4d4f5253454c // "MORSEL"

type Direction string

const (
	Up   Direction = "up"
	Down Direction = "down"
)

type migration struct {
	version int64
	up      string
	down    string
}

func Run(ctx context.Context, pool *pgxpool.Pool, direction Direction, steps int) error {
	if direction != Up && direction != Down {
		return fmt.Errorf("invalid migration direction %q", direction)
	}
	if steps < 0 {
		return errors.New("migration steps must not be negative")
	}

	migrations, err := load()
	if err != nil {
		return err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", advisoryLockID); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() { _, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", advisoryLockID) }()

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version bigint PRIMARY KEY,
		dirty boolean NOT NULL,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("create migration metadata: %w", err)
	}

	applied, err := appliedVersions(ctx, conn)
	if err != nil {
		return err
	}
	known := make(map[int64]migration, len(migrations))
	for _, m := range migrations {
		known[m.version] = m
	}
	for _, version := range applied {
		if _, ok := known[version]; !ok {
			return fmt.Errorf("database has unknown migration version %d", version)
		}
	}
	if !slices.IsSorted(applied) {
		return errors.New("applied migrations are not ordered")
	}
	for i, version := range applied {
		if i >= len(migrations) || migrations[i].version != version {
			return fmt.Errorf("database migration history has a gap at version %d", version)
		}
	}

	if direction == Up {
		remaining := migrations[len(applied):]
		if steps > 0 && steps < len(remaining) {
			remaining = remaining[:steps]
		}
		for _, m := range remaining {
			if err := applyUp(ctx, conn, m); err != nil {
				return err
			}
		}
		return nil
	}

	remaining := slices.Clone(applied)
	slices.Reverse(remaining)
	if steps == 0 {
		steps = 1
	}
	if steps < len(remaining) {
		remaining = remaining[:steps]
	}
	for _, version := range remaining {
		if err := applyDown(ctx, conn, known[version]); err != nil {
			return err
		}
	}
	return nil
}

func appliedVersions(ctx context.Context, conn *pgxpool.Conn) ([]int64, error) {
	rows, err := conn.Query(ctx, "SELECT version, dirty FROM schema_migrations ORDER BY version")
	if err != nil {
		return nil, fmt.Errorf("read migration metadata: %w", err)
	}
	defer rows.Close()
	var versions []int64
	for rows.Next() {
		var version int64
		var dirty bool
		if err := rows.Scan(&version, &dirty); err != nil {
			return nil, fmt.Errorf("scan migration metadata: %w", err)
		}
		if dirty {
			return nil, fmt.Errorf("migration version %d is dirty", version)
		}
		versions = append(versions, version)
	}
	return versions, rows.Err()
}

func applyUp(ctx context.Context, conn *pgxpool.Conn, m migration) error {
	if _, err := conn.Exec(ctx, "INSERT INTO schema_migrations (version, dirty) VALUES ($1, true)", m.version); err != nil {
		return fmt.Errorf("mark migration %d dirty: %w", m.version, err)
	}
	return inTx(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, m.up); err != nil {
			return fmt.Errorf("apply migration %d up: %w", m.version, err)
		}
		if _, err := tx.Exec(ctx, "UPDATE schema_migrations SET dirty = false, applied_at = now() WHERE version = $1", m.version); err != nil {
			return fmt.Errorf("mark migration %d clean: %w", m.version, err)
		}
		return nil
	})
}

func applyDown(ctx context.Context, conn *pgxpool.Conn, m migration) error {
	if _, err := conn.Exec(ctx, "UPDATE schema_migrations SET dirty = true WHERE version = $1", m.version); err != nil {
		return fmt.Errorf("mark migration %d dirty: %w", m.version, err)
	}
	return inTx(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, m.down); err != nil {
			return fmt.Errorf("apply migration %d down: %w", m.version, err)
		}
		if _, err := tx.Exec(ctx, "DELETE FROM schema_migrations WHERE version = $1", m.version); err != nil {
			return fmt.Errorf("remove migration %d metadata: %w", m.version, err)
		}
		return nil
	})
}

func inTx(ctx context.Context, conn *pgxpool.Conn, fn func(pgx.Tx) error) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func load() ([]migration, error) {
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		return nil, fmt.Errorf("read embedded migrations: %w", err)
	}
	byVersion := map[int64]*migration{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		parts := strings.Split(entry.Name(), ".")
		if len(parts) != 3 || parts[2] != "sql" || (parts[1] != "up" && parts[1] != "down") {
			return nil, fmt.Errorf("invalid migration filename %q", entry.Name())
		}
		underscore := strings.IndexByte(parts[0], '_')
		if underscore < 1 {
			return nil, fmt.Errorf("invalid migration filename %q", entry.Name())
		}
		version, err := strconv.ParseInt(parts[0][:underscore], 10, 64)
		if err != nil || version <= 0 {
			return nil, fmt.Errorf("invalid migration version in %q", entry.Name())
		}
		body, err := files.ReadFile(entry.Name())
		if err != nil {
			return nil, err
		}
		m := byVersion[version]
		if m == nil {
			m = &migration{version: version}
			byVersion[version] = m
		}
		if parts[1] == "up" {
			m.up = string(body)
		} else {
			m.down = string(body)
		}
	}
	result := make([]migration, 0, len(byVersion))
	for _, m := range byVersion {
		if m.up == "" || m.down == "" {
			return nil, fmt.Errorf("migration %d requires up and down files", m.version)
		}
		result = append(result, *m)
	}
	slices.SortFunc(result, func(a, b migration) int { return cmp.Compare(a.version, b.version) })
	return result, nil
}
