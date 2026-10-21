// Command test-auth provides database isolation for the real-backend browser suite.
// It is not part of the release image.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
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
	if len(args) != 1 || (args[0] != "expire-sessions" && args[0] != "assert-no-secret") {
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
	if args[0] == "expire-sessions" {
		_, err := conn.Exec(ctx, `UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second'`)
		return err
	}
	secret, err := io.ReadAll(io.LimitReader(os.Stdin, 4097))
	if err != nil || len(secret) < 32 || len(secret) > 4096 {
		return errors.New("invalid secret input")
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
