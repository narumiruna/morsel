package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Environment       string
	Address           string
	DatabaseURL       string
	APIKeys           []string
	AllowedOrigins    []string
	PublicViewerURL   *url.URL
	MaxDocumentBytes  int64
	MaxRequestBytes   int64
	ReadHeaderTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
	RequestTimeout    time.Duration
	ShutdownTimeout   time.Duration
	LogLevel          slog.Level
}

func Load() (Config, error) {
	cfg := Config{
		Environment:       env("MORSEL_ENVIRONMENT", "development"),
		Address:           env("MORSEL_ADDRESS", ":8080"),
		DatabaseURL:       os.Getenv("MORSEL_DATABASE_URL"),
		MaxDocumentBytes:  1 << 20,
		MaxRequestBytes:   (1 << 20) + (64 << 10),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		RequestTimeout:    20 * time.Second,
		ShutdownTimeout:   10 * time.Second,
	}
	var err error
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("MORSEL_DATABASE_URL is required")
	}
	if cfg.APIKeys, err = loadValues("MORSEL_API_KEYS", "MORSEL_API_KEYS_FILE"); err != nil {
		return Config{}, fmt.Errorf("load API keys: %w", err)
	}
	if len(cfg.APIKeys) == 0 {
		return Config{}, errors.New("at least one API key is required")
	}
	for _, key := range cfg.APIKeys {
		if len(key) < 32 {
			return Config{}, errors.New("each API key must contain at least 32 characters")
		}
	}
	if cfg.AllowedOrigins, err = loadValues("MORSEL_ALLOWED_ORIGINS", "MORSEL_ALLOWED_ORIGINS_FILE"); err != nil {
		return Config{}, fmt.Errorf("load allowed origins: %w", err)
	}
	if len(cfg.AllowedOrigins) == 0 {
		return Config{}, errors.New("at least one allowed origin is required")
	}
	for i, origin := range cfg.AllowedOrigins {
		parsed, parseErr := parseOrigin(origin, cfg.Environment)
		if parseErr != nil {
			return Config{}, fmt.Errorf("invalid allowed origin at position %d: %w", i+1, parseErr)
		}
		cfg.AllowedOrigins[i] = parsed
	}
	viewer := os.Getenv("MORSEL_PUBLIC_VIEWER_URL")
	if viewer == "" {
		return Config{}, errors.New("MORSEL_PUBLIC_VIEWER_URL is required")
	}
	cfg.PublicViewerURL, err = parsePublicURL(viewer, cfg.Environment)
	if err != nil {
		return Config{}, fmt.Errorf("invalid public viewer URL: %w", err)
	}
	if cfg.MaxDocumentBytes, err = intEnv("MORSEL_MAX_DOCUMENT_BYTES", cfg.MaxDocumentBytes); err != nil {
		return Config{}, err
	}
	if cfg.MaxRequestBytes, err = intEnv("MORSEL_MAX_REQUEST_BYTES", cfg.MaxRequestBytes); err != nil {
		return Config{}, err
	}
	if cfg.MaxDocumentBytes <= 0 || cfg.MaxRequestBytes <= cfg.MaxDocumentBytes {
		return Config{}, errors.New("request limit must be greater than positive document limit")
	}
	for name, target := range map[string]*time.Duration{
		"MORSEL_READ_HEADER_TIMEOUT": &cfg.ReadHeaderTimeout,
		"MORSEL_READ_TIMEOUT":        &cfg.ReadTimeout,
		"MORSEL_WRITE_TIMEOUT":       &cfg.WriteTimeout,
		"MORSEL_IDLE_TIMEOUT":        &cfg.IdleTimeout,
		"MORSEL_REQUEST_TIMEOUT":     &cfg.RequestTimeout,
		"MORSEL_SHUTDOWN_TIMEOUT":    &cfg.ShutdownTimeout,
	} {
		if *target, err = durationEnv(name, *target); err != nil {
			return Config{}, err
		}
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(env("MORSEL_LOG_LEVEL", "info"))); err != nil {
		return Config{}, errors.New("MORSEL_LOG_LEVEL must be debug, info, warn, or error")
	}
	return cfg, nil
}

func loadValues(valueEnv, fileEnv string) ([]string, error) {
	var values []string
	if raw := os.Getenv(valueEnv); raw != "" {
		values = append(values, strings.Split(raw, ",")...)
	}
	if path := os.Getenv(fileEnv); path != "" {
		body, err := os.ReadFile(path)
		if err != nil {
			return nil, errors.New("cannot read configured file")
		}
		values = append(values, strings.Split(string(body), "\n")...)
	}
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

func parseOrigin(raw, environment string) (string, error) {
	if raw == "*" {
		return "", errors.New("wildcard origins are forbidden")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("origin must contain only scheme and host")
	}
	if err := requireSafeHTTPURL(u, environment); err != nil {
		return "", err
	}
	return u.Scheme + "://" + u.Host, nil
}

func parsePublicURL(raw, environment string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("must be an absolute URL without credentials, query, or fragment")
	}
	if err := requireSafeHTTPURL(u, environment); err != nil {
		return nil, err
	}
	if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	return u, nil
}

func requireSafeHTTPURL(u *url.URL, environment string) error {
	if u.Scheme == "https" {
		return nil
	}
	host := u.Hostname()
	if environment != "production" && u.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1") {
		return nil
	}
	return errors.New("must use HTTPS (HTTP is allowed only for local development)")
}

func intEnv(name string, fallback int64) (int64, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return value, nil
}

func durationEnv(name string, fallback time.Duration) (time.Duration, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", name)
	}
	return value, nil
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
