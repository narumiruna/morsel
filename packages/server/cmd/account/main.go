// Command account issues a one-use setup, invitation, or account recovery grant.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/internal/auth"
)

func grantArguments(args []string) (string, uuid.UUID, error) {
	flags := flag.NewFlagSet("account", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	kind := flags.String("kind", "", "grant kind: setup, invite, or recover")
	rawID := flags.String("account-id", "", "account UUID required for recover")
	usage := errors.New("usage: account -kind setup|invite or account -kind recover -account-id <uuid>")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return "", uuid.Nil, usage
	}
	if *kind == "setup" || *kind == "invite" {
		if *rawID == "" {
			return *kind, uuid.Nil, nil
		}
	} else if *kind == "recover" {
		id, err := uuid.Parse(*rawID)
		if err == nil && id != uuid.Nil {
			return *kind, id, nil
		}
	}
	return "", uuid.Nil, usage
}

func main() {
	kind, accountID, err := grantArguments(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
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
	token, err := auth.IssueGrant(ctx, pool, kind, accountID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot issue grant:", err)
		os.Exit(1)
	}
	// stdout contains only the token. Do not log or persist this value elsewhere.
	fmt.Println(token)
}
