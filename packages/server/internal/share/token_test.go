package share

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func TestTokenGenerator(t *testing.T) {
	raw := bytes.Repeat([]byte{0xab}, TokenBytes)
	token, hash, err := (TokenGenerator{Reader: bytes.NewReader(raw)}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != TokenLength {
		t.Fatalf("token length = %d", len(token))
	}
	if token != base64.RawURLEncoding.EncodeToString(raw) {
		t.Fatalf("unexpected token %q", token)
	}
	if hash != sha256.Sum256([]byte(token)) {
		t.Fatal("unexpected token hash")
	}
	validated, err := HashToken(token)
	if err != nil || validated != hash {
		t.Fatalf("validate token: %v", err)
	}
}

func TestTokenGeneratorFailure(t *testing.T) {
	_, _, err := (TokenGenerator{Reader: errorReader{}}).Generate()
	if err == nil {
		t.Fatal("expected entropy failure")
	}
}

func TestHashTokenPreservesOriginalSpelling(t *testing.T) {
	legacy := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xab}, 32))
	hex := strings.Repeat("ab", 32)
	for _, token := range []string{legacy, hex} {
		got, err := HashToken(token)
		if err != nil || got != sha256.Sum256([]byte(token)) {
			t.Fatalf("hash of %d-character token = %x, %v", len(token), got, err)
		}
	}
}

func TestHashTokenRejectsMalformedValues(t *testing.T) {
	for _, token := range []string{
		"", "abc", strings.Repeat("!", 43), strings.Repeat("A", 44),
		strings.Repeat("A", 43) + "=", strings.Repeat("A", 42) + "B",
		strings.Repeat("A", 21) + "\n" + strings.Repeat("A", 21),
		strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("A", 64),
		strings.Repeat("a", 63) + "g", strings.Repeat("a", 63) + "\n",
	} {
		if _, err := HashToken(token); err == nil {
			t.Fatalf("accepted malformed token %q", token)
		}
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, errors.New("entropy unavailable") }
