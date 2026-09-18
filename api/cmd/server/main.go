package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	morselapi "github.com/narumiruna/morsel/api/internal/api"
	"github.com/narumiruna/morsel/api/internal/config"
	"github.com/narumiruna/morsel/api/internal/share"
	viewerfiles "github.com/narumiruna/morsel/api/internal/viewer"
)

func main() {
	os.Exit(run())
}

func run() int {
	healthcheck := flag.Bool("healthcheck", false, "check the local readiness endpoint")
	flag.Parse()
	if *healthcheck {
		if err := checkHealth(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid configuration: %v\n", err)
		return 2
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		logger.Error("invalid database configuration")
		return 2
	}
	poolConfig.MaxConns = 10
	poolConfig.MinConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		logger.Error("initialize database pool", "error", err)
		return 1
	}
	defer pool.Close()

	repository := share.NewPostgresRepository(pool)
	viewer, err := viewerfiles.New(cfg.ViewerDir, repository, cfg.PublicViewerURL)
	if err != nil {
		logger.Error("initialize viewer", "error", err)
		return 1
	}
	handler := morselapi.NewService(repository, share.TokenGenerator{}, cfg.PublicViewerURL, cfg.MaxDocumentBytes, logger)
	router := morselapi.NewRouter(handler, morselapi.RouterConfig{
		APIKeys: cfg.APIKeys, Viewer: viewer,
		MaxRequestBody: cfg.MaxRequestBytes, RequestTimeout: cfg.RequestTimeout, Logger: logger,
	})
	server := &http.Server{
		Addr: cfg.Address, Handler: router,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout, ReadTimeout: cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout, IdleTimeout: cfg.IdleTimeout,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger.Info("server listening", "address", cfg.Address)
	if err := serve(ctx, server, cfg.ShutdownTimeout); err != nil {
		logger.Error("server stopped unexpectedly", "error", err)
		return 1
	}
	return 0
}

func serve(ctx context.Context, server *http.Server, shutdownTimeout time.Duration) error {
	serverError := make(chan error, 1)
	go func() {
		serverError <- server.ListenAndServe()
	}()

	select {
	case err := <-serverError:
		if err == nil {
			return errors.New("HTTP server stopped without an error")
		}
		return fmt.Errorf("listen and serve: %w", err)
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		_ = server.Close()
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	if err := <-serverError; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("listen and serve during shutdown: %w", err)
	}
	return nil
}

func checkHealth() error {
	target, err := healthcheckURL(os.Getenv("MORSEL_ADDRESS"))
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(target)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("readiness returned %s", response.Status)
	}
	return nil
}

func healthcheckURL(address string) (string, error) {
	if address == "" {
		address = ":12647"
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil || port == "" || port == "0" {
		return "", errors.New("MORSEL_ADDRESS must include a fixed TCP port")
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/readyz", nil
}
