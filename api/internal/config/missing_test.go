package config

import "testing"

func TestLoadRejectsMissingRequiredValues(t *testing.T) {
	for _, name := range []string{
		"MORSEL_DATABASE_URL",
		"MORSEL_API_KEYS",
		"MORSEL_API_KEYS_FILE",
		"MORSEL_PUBLIC_VIEWER_URL",
	} {
		t.Setenv(name, "")
	}
	if _, err := Load(); err == nil {
		t.Fatal("expected missing configuration error")
	}
}
