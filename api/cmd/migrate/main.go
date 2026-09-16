package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/api/migrations"
)

func main() {
	directionFlag := flag.String("direction", "up", "migration direction: up or down")
	steps := flag.Int("steps", 0, "number of migrations (0 means all for up, one for down)")
	flag.Parse()

	databaseURL := os.Getenv("MORSEL_DATABASE_URL")
	if databaseURL == "" {
		fmt.Fprintln(os.Stderr, "MORSEL_DATABASE_URL is required")
		os.Exit(2)
	}
	direction := migrations.Direction(*directionFlag)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		slog.Error("configure database")
		os.Exit(1)
	}
	defer pool.Close()
	if err := migrations.Run(ctx, pool, direction, *steps); err != nil {
		slog.Error("run migrations", "error", err)
		os.Exit(1)
	}
	slog.Info("migrations complete", "direction", direction, "steps", *steps)
}
