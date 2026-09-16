package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("MORSEL_DATABASE_URL", "postgres://morsel:secret@db/morsel")
	t.Setenv("MORSEL_API_KEYS", strings.Repeat("k", 32))
	t.Setenv("MORSEL_ALLOWED_ORIGINS", "https://viewer.example.com")
	t.Setenv("MORSEL_PUBLIC_VIEWER_URL", "https://viewer.example.com/morsel")
	t.Setenv("MORSEL_ENVIRONMENT", "production")
}

func TestLoadValidConfiguration(t *testing.T) {
	validEnvironment(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicViewerURL.String() != "https://viewer.example.com/morsel/" {
		t.Fatalf("viewer URL = %q", cfg.PublicViewerURL)
	}
	if cfg.MaxRequestBytes <= cfg.MaxDocumentBytes || len(cfg.APIKeys) != 1 {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadValuesFromFiles(t *testing.T) {
	validEnvironment(t)
	directory := t.TempDir()
	keys := filepath.Join(directory, "keys")
	origins := filepath.Join(directory, "origins")
	if err := os.WriteFile(keys, []byte(strings.Repeat("a", 32)+"\n"+strings.Repeat("b", 32)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(origins, []byte("https://one.example\nhttps://two.example\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MORSEL_API_KEYS", "")
	t.Setenv("MORSEL_API_KEYS_FILE", keys)
	t.Setenv("MORSEL_ALLOWED_ORIGINS", "")
	t.Setenv("MORSEL_ALLOWED_ORIGINS_FILE", origins)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.APIKeys) != 2 || len(cfg.AllowedOrigins) != 2 {
		t.Fatalf("file values not loaded: %+v", cfg)
	}
}

func TestLoadRejectsUnsafeConfigurationWithoutLeakingSecrets(t *testing.T) {
	tests := []struct {
		name   string
		key    string
		value  string
		needle string
	}{
		{name: "wildcard origin", key: "MORSEL_ALLOWED_ORIGINS", value: "*", needle: "wildcard"},
		{name: "insecure origin", key: "MORSEL_ALLOWED_ORIGINS", value: "http://viewer.example.com", needle: "HTTPS"},
		{name: "origin path", key: "MORSEL_ALLOWED_ORIGINS", value: "https://viewer.example.com/path", needle: "scheme and host"},
		{name: "insecure viewer", key: "MORSEL_PUBLIC_VIEWER_URL", value: "http://viewer.example.com", needle: "HTTPS"},
		{name: "short API key", key: "MORSEL_API_KEYS", value: "super-secret", needle: "32"},
		{name: "bad timeout", key: "MORSEL_REQUEST_TIMEOUT", value: "never", needle: "positive duration"},
		{name: "bad limits", key: "MORSEL_MAX_REQUEST_BYTES", value: "1", needle: "greater"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			validEnvironment(t)
			t.Setenv(test.key, test.value)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), test.needle) {
				t.Fatalf("expected %q error, got %v", test.needle, err)
			}
			if strings.Contains(err.Error(), "super-secret") || strings.Contains(err.Error(), "postgres://") {
				t.Fatalf("configuration error leaked a secret: %v", err)
			}
		})
	}
}

func TestLoadAllowsLocalHTTPInDevelopment(t *testing.T) {
	validEnvironment(t)
	t.Setenv("MORSEL_ENVIRONMENT", "development")
	t.Setenv("MORSEL_ALLOWED_ORIGINS", "http://localhost:5173")
	t.Setenv("MORSEL_PUBLIC_VIEWER_URL", "http://127.0.0.1:5173")
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}
