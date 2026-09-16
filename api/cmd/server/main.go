package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	morselapi "github.com/narumiruna/morsel/api/internal/api"
	"github.com/narumiruna/morsel/api/internal/config"
	"github.com/narumiruna/morsel/api/internal/share"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "check the local readiness endpoint")
	flag.Parse()
	if *healthcheck {
		if err := checkHealth(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid configuration: %v\n", err)
		os.Exit(2)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		logger.Error("invalid database configuration")
		os.Exit(2)
	}
	poolConfig.MaxConns = 10
	poolConfig.MinConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		logger.Error("initialize database pool", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	repository := share.NewPostgresRepository(pool)
	handler := morselapi.NewService(repository, share.TokenGenerator{}, cfg.PublicViewerURL, cfg.MaxDocumentBytes, logger)
	router := morselapi.NewRouter(handler, morselapi.RouterConfig{
		APIKeys: cfg.APIKeys, AllowedOrigins: cfg.AllowedOrigins,
		MaxRequestBody: cfg.MaxRequestBytes, RequestTimeout: cfg.RequestTimeout, Logger: logger,
	})
	server := &http.Server{
		Addr: cfg.Address, Handler: router,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout, ReadTimeout: cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout, IdleTimeout: cfg.IdleTimeout,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		logger.Info("server listening", "address", cfg.Address)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server stopped unexpectedly", "error", err)
			stop()
		}
	}()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		_ = server.Close()
	}
}

func checkHealth() error {
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Get("http://127.0.0.1:8080/readyz")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("readiness returned %s", response.Status)
	}
	return nil
}
