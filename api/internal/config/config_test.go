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
	t.Setenv("MORSEL_API_KEY", strings.Repeat("k", 32))
	t.Setenv("MORSEL_URL", "https://morsel.example.com/")
	t.Setenv("MORSEL_ENVIRONMENT", "production")
}

func TestLoadValidConfiguration(t *testing.T) {
	validEnvironment(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicViewerURL.String() != "https://morsel.example.com/" {
		t.Fatalf("viewer URL = %q", cfg.PublicViewerURL)
	}
	if cfg.ViewerDir != "../packages/viewer/dist" {
		t.Fatalf("viewer directory = %q", cfg.ViewerDir)
	}
	if cfg.MaxRequestBytes <= cfg.MaxDocumentBytes || len(cfg.APIKeys) != 1 {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadAPIKeysFromFile(t *testing.T) {
	validEnvironment(t)
	keys := filepath.Join(t.TempDir(), "keys")
	if err := os.WriteFile(keys, []byte(strings.Repeat("a", 32)+"\n"+strings.Repeat("b", 32)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MORSEL_API_KEY", "")
	t.Setenv("MORSEL_API_KEY_FILE", keys)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.APIKeys) != 2 {
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
		{name: "empty viewer directory", key: "MORSEL_VIEWER_DIR", value: " ", needle: "must not be empty"},
		{name: "insecure viewer", key: "MORSEL_URL", value: "http://morsel.example.com", needle: "HTTPS"},
		{name: "viewer path", key: "MORSEL_URL", value: "https://morsel.example.com/app", needle: "without credentials"},
		{name: "short API key", key: "MORSEL_API_KEY", value: "super-secret", needle: "32"},
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
	t.Setenv("MORSEL_URL", "http://127.0.0.1:5173")
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}
