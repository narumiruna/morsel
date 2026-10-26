// Command test-auth provides database isolation for the real-backend browser suite.
// It is not part of the release image.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/migrations"
)

var databaseName = regexp.MustCompile(`^morsel_auth_e2e_[0-9a-f]{24}$`)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil {
		// PostgreSQL errors and URLs can contain credentials. Never print them.
		fmt.Fprintln(os.Stderr, "authentication test database operation failed")
		os.Exit(1)
	}
}

// databaseConnection changes the target without allowing query aliases to
// override it. Parse the result with the same driver used by the server.
func databaseConnection(raw, name string) (string, error) {
	if raw == "" || !databaseName.MatchString(name) {
		return "", errors.New("invalid disposable database connection")
	}
	derived := raw + " dbname=" + name
	if strings.HasPrefix(raw, "postgres://") || strings.HasPrefix(raw, "postgresql://") {
		u, err := url.Parse(raw)
		if err != nil {
			return "", err
		}
		u.Path = "/" + name
		u.RawPath = ""
		query := u.Query()
		query.Del("dbname")
		query.Del("database")
		u.RawQuery = query.Encode()
		derived = u.String()
	}
	cfg, err := pgx.ParseConfig(derived)
	if err != nil || cfg.Database != name {
		return "", errors.New("disposable database target mismatch")
	}
	return derived, nil
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("command required")
	}
	if args[0] == "database-create" || args[0] == "database-drop" {
		if len(args) != 2 || !databaseName.MatchString(args[1]) {
			return errors.New("invalid disposable database name")
		}
		raw := os.Getenv("MORSEL_TEST_DATABASE_URL")
		if raw == "" {
			return errors.New("test administrator connection required")
		}
		derived, err := databaseConnection(raw, args[1])
		if err != nil {
			return err
		}
		conn, err := pgx.Connect(ctx, raw)
		if err != nil {
			return err
		}
		defer conn.Close(ctx)
		name := pgx.Identifier{args[1]}.Sanitize()
		if args[0] == "database-drop" {
			_, err = conn.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
			return err
		}
		if _, err = conn.Exec(ctx, "CREATE DATABASE "+name+" TEMPLATE template0"); err != nil {
			return err
		}
		fmt.Println(derived)
		return nil
	}
	var accountID uuid.UUID
	switch args[0] {
	case "expire-sessions", "expire-verification", "seed-legacy-share":
		if len(args) != 2 {
			return errors.New("account ID required")
		}
		var err error
		accountID, err = uuid.Parse(args[1])
		if err != nil || accountID == uuid.Nil {
			return errors.New("invalid account ID")
		}
	case "assert-no-secret", "assert-invitation", "expire-invitation":
		if len(args) != 1 {
			return errors.New("unexpected arguments")
		}
	default:
		return errors.New("unknown command")
	}
	cfg, err := pgx.ParseConfig(os.Getenv("MORSEL_DATABASE_URL"))
	if err != nil || !databaseName.MatchString(cfg.Database) {
		return errors.New("operation requires disposable database")
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	if args[0] == "seed-legacy-share" {
		// The browser must finish setup and settle all requests before this
		// test-only transition. Never insert an ownerless row in schema 11/12.
		// Use the real single-account 12 -> 10 downgrade, then upgrade to 12.
		// A sole user is not safe: upgrading would promote it to admin.
		const id = "00000000-0000-4000-8000-000000000001"
		var safe bool
		if err := conn.QueryRow(ctx, `SELECT
			(SELECT count(*)=12 AND min(version)=1 AND max(version)=12 AND NOT bool_or(dirty) FROM schema_migrations)
			AND (SELECT count(*)=1 FROM accounts)
			AND EXISTS(SELECT 1 FROM accounts WHERE id=$1 AND role='admin')
			AND NOT EXISTS(SELECT 1 FROM auth_flows WHERE expires_at>clock_timestamp())`, accountID).Scan(&safe); err != nil {
			return err
		}
		if !safe {
			return errors.New("legacy fixture requires clean schema 12, sole matching admin, and no active flows")
		}
		pool, err := pgxpool.New(ctx, os.Getenv("MORSEL_DATABASE_URL"))
		if err != nil {
			return err
		}
		defer pool.Close()
		if err := migrations.Run(ctx, pool, migrations.Down, 2); err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, `INSERT INTO shares (id, token_hash, content, created_at)
			VALUES ($1, decode(repeat('ab', 32), 'hex'), '# Legacy before account', '2020-01-01T00:00:00Z')`, id); err != nil {
			return err
		}
		if err := migrations.Run(ctx, pool, migrations.Up, 0); err != nil {
			return err
		}
		for {
			count, err := share.BackfillLabels(ctx, pool, 16)
			if err != nil {
				return err
			}
			if count == 0 {
				break
			}
		}
		fmt.Println(id)
		return nil
	}
	if args[0] == "expire-sessions" {
		_, err := conn.Exec(ctx, `UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1`, accountID)
		return err
	}
	if args[0] == "expire-verification" {
		_, err := conn.Exec(ctx, `UPDATE auth_sessions SET verified_at=to_timestamp(0) WHERE account_id=$1`, accountID)
		return err
	}
	secret, err := io.ReadAll(io.LimitReader(os.Stdin, 4097))
	if err != nil || len(secret) < 32 || len(secret) > 4096 {
		return errors.New("invalid secret input")
	}
	raw := strings.TrimSpace(string(secret))
	if args[0] == "assert-invitation" || args[0] == "expire-invitation" {
		decoded, err := base64.RawURLEncoding.Strict().DecodeString(raw)
		if err != nil || len(raw) != 43 || len(decoded) != 32 {
			return errors.New("invalid invitation input")
		}
		hash := sha256.Sum256([]byte(raw))
		if args[0] == "expire-invitation" {
			tag, err := conn.Exec(ctx, `UPDATE auth_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1 AND kind='invite'`, hash[:])
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return errors.New("invitation fixture missing")
			}
			return nil
		}
		var valid bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM auth_grants
			WHERE token_hash=$1 AND kind='invite' AND account_id IS NULL AND generation IS NULL
			AND expires_at>clock_timestamp() AND expires_at<=clock_timestamp()+interval '1 hour')`, hash[:]).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return errors.New("hashed one-hour invitation missing")
		}
		return nil
	}
	rows, err := conn.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname=current_schema()`)
	if err != nil {
		return err
	}
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			rows.Close()
			return err
		}
		tables = append(tables, table)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, table := range tables {
		var found bool
		query := "SELECT EXISTS(SELECT 1 FROM " + pgx.Identifier{table}.Sanitize() + " AS record WHERE strpos(row_to_json(record)::text,$1)>0)"
		if err := conn.QueryRow(ctx, query, strings.TrimSpace(string(secret))).Scan(&found); err != nil {
			return err
		}
		if found {
			return errors.New("raw secret persisted")
		}
	}
	return nil
}
