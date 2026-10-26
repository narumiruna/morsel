package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/morsel/packages/server/internal/share"
	"github.com/narumiruna/morsel/packages/server/migrations"
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		slog.Error("configure database")
		os.Exit(1)
	}
	defer pool.Close()
	if err := migrate(ctx, pool, direction, *steps); err != nil {
		slog.Error("run migrations; rerun up to resume pending label backfill", "error", err)
		os.Exit(1)
	}
	slog.Info("migrations complete", "direction", direction, "steps", *steps)
}

func migrate(ctx context.Context, pool *pgxpool.Pool, direction migrations.Direction, steps int) error {
	if err := migrations.Run(ctx, pool, direction, steps); err != nil {
		return err
	}
	if direction == migrations.Up {
		// A targeted migration to an older schema must not run a newer backfill.
		var labelsExist bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='shares' AND column_name='admin_label')").Scan(&labelsExist); err != nil {
			return fmt.Errorf("check label schema: %w", err)
		}
		if labelsExist {
			for {
				n, err := share.BackfillLabels(ctx, pool, 16)
				if err != nil {
					return fmt.Errorf("backfill labels: %w", err)
				}
				if n == 0 {
					break
				}
			}
		}
	}
	return nil
}
