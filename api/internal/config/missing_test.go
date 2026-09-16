package config

import "testing"

func TestLoadRejectsMissingRequiredValues(t *testing.T) {
	for _, name := range []string{
		"MORSEL_DATABASE_URL",
		"MORSEL_API_KEY",
		"MORSEL_API_KEY_FILE",
		"MORSEL_URL",
	} {
		t.Setenv(name, "")
	}
	if _, err := Load(); err == nil {
		t.Fatal("expected missing configuration error")
	}
}
