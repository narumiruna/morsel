package config

import (
	"strings"
	"testing"
)

func validEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("MORSEL_DATABASE_URL", "postgres://morsel:secret@db/morsel")
	t.Setenv("MORSEL_API_KEY", "")
	t.Setenv("MORSEL_API_KEY_FILE", "")
	t.Setenv("MORSEL_URL", "https://morsel.example.com/")
	t.Setenv("MORSEL_ENVIRONMENT", "production")
	t.Setenv("MORSEL_VIEWER_DIR", "")
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
	if cfg.ViewerDir != "../viewer/dist" {
		t.Fatalf("viewer directory = %q", cfg.ViewerDir)
	}
	if cfg.MaxRequestBytes <= cfg.MaxDocumentBytes {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadUsesConfiguredViewerDirectory(t *testing.T) {
	validEnvironment(t)
	t.Setenv("MORSEL_VIEWER_DIR", "/srv/custom-viewer")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ViewerDir != "/srv/custom-viewer" {
		t.Fatalf("viewer directory = %q", cfg.ViewerDir)
	}
}

func TestLoadDoesNotReadLegacyServerKeys(t *testing.T) {
	validEnvironment(t)
	t.Setenv("MORSEL_API_KEY", "short-obsolete-key")
	t.Setenv("MORSEL_API_KEY_FILE", "/nonexistent/legacy-key-file")
	if _, err := Load(); err != nil {
		t.Fatalf("obsolete server key configuration must not be used: %v", err)
	}
}

func TestLoadIgnoresRemovedShareLinkKey(t *testing.T) {
	for _, key := range []string{"", "invalid-removed-key"} {
		validEnvironment(t)
		t.Setenv("MORSEL_SHARE_LINK_KEY", key)
		if _, err := Load(); err != nil {
			t.Fatalf("removed share link key must not affect startup: %v", err)
		}
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
