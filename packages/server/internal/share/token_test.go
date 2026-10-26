package share

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
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

func TestHashTokenRejectsMalformedValues(t *testing.T) {
	for _, token := range []string{"", "abc", "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
		if _, err := HashToken(token); err == nil {
			t.Fatalf("accepted malformed token %q", token)
		}
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, errors.New("entropy unavailable") }
