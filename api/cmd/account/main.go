// Command account issues a one-use owner setup or recovery grant.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/api/internal/auth"
)

func main() {
	kind := flag.String("kind", "", "grant kind: setup or recover")
	flag.Parse()
	if (*kind != "setup" && *kind != "recover") || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: account -kind setup|recover")
		os.Exit(2)
	}
	databaseURL := os.Getenv("MORSEL_DATABASE_URL")
	if databaseURL == "" {
		fmt.Fprintln(os.Stderr, "MORSEL_DATABASE_URL is required")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot configure database")
		os.Exit(1)
	}
	defer pool.Close()
	token, err := auth.IssueGrant(ctx, pool, *kind)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot issue grant:", err)
		os.Exit(1)
	}
	// stdout contains only the token. Do not log or persist this value elsewhere.
	fmt.Println(token)
}
