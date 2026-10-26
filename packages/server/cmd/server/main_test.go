package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthcheckURLUsesConfiguredAddress(t *testing.T) {
	tests := []struct {
		address string
		want    string
	}{
		{"", "http://127.0.0.1:12647/readyz"},
		{":9090", "http://127.0.0.1:9090/readyz"},
		{"0.0.0.0:7070", "http://127.0.0.1:7070/readyz"},
		{"[::]:6060", "http://127.0.0.1:6060/readyz"},
		{"localhost:5050", "http://localhost:5050/readyz"},
	}
	for _, test := range tests {
		got, err := healthcheckURL(test.address)
		if err != nil || got != test.want {
			t.Errorf("healthcheckURL(%q)=%q, %v; want %q", test.address, got, err, test.want)
		}
	}
	for _, address := range []string{"12647", ":0"} {
		if _, err := healthcheckURL(address); err == nil {
			t.Errorf("healthcheckURL(%q) succeeded", address)
		}
	}
}

func TestCheckHealthUsesConfiguredPort(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	t.Setenv("MORSEL_ADDRESS", server.Listener.Addr().String())
	if err := checkHealth(); err != nil {
		t.Fatal(err)
	}
}

func TestServeReturnsListenerFailure(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	server := &http.Server{
		Addr:              listener.Addr().String(),
		Handler:           http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}),
		ReadHeaderTimeout: time.Second,
	}
	err = serve(context.Background(), server, time.Second)
	if err == nil || !strings.Contains(err.Error(), "listen and serve") {
		t.Fatalf("expected listener error, got %v", err)
	}
}

func TestCheckHealthRejectsUnreadyResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, "not ready")
	}))
	defer server.Close()
	t.Setenv("MORSEL_ADDRESS", server.Listener.Addr().String())
	if err := checkHealth(); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("expected readiness error, got %v", err)
	}
}
