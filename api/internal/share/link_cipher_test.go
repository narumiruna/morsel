package share

import (
	"bytes"
	"testing"

	"github.com/google/uuid"
)

func TestLinkCipher(t *testing.T) {
	key := bytes.Repeat([]byte{1}, 32)
	cipher, err := NewLinkCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.New()
	token, hash, err := (TokenGenerator{}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	first, err := cipher.Encrypt(id, token)
	if err != nil {
		t.Fatal(err)
	}
	second, err := cipher.Encrypt(id, token)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first, second) || bytes.Contains(first, []byte(token)) {
		t.Fatal("encryption must use random nonces and conceal the capability")
	}
	restarted, _ := NewLinkCipher(key)
	if got, err := restarted.Decrypt(id, first, hash); err != nil || got != token {
		t.Fatalf("round trip failed: %v", err)
	}
	wrongKey, _ := NewLinkCipher(bytes.Repeat([]byte{2}, 32))
	corrupt := bytes.Clone(first)
	corrupt[len(corrupt)-1] ^= 1
	for _, test := range []struct {
		name   string
		cipher *LinkCipher
		id     uuid.UUID
		data   []byte
		hash   [32]byte
	}{
		{"wrong key", wrongKey, id, first, hash},
		{"swapped row", cipher, uuid.New(), first, hash},
		{"corruption", cipher, id, corrupt, hash},
		{"truncated", cipher, id, first[:10], hash},
		{"empty", cipher, id, nil, hash},
		{"hash mismatch", cipher, id, first, [32]byte{}},
		{"missing cipher", nil, id, first, hash},
	} {
		t.Run(test.name, func(t *testing.T) {
			if result, err := test.cipher.Decrypt(test.id, test.data, test.hash); err == nil || result != "" {
				t.Fatal("invalid ciphertext returned a capability")
			}
		})
	}
	for _, size := range []int{0, 16, 24, 31, 33} {
		if _, err := NewLinkCipher(make([]byte, size)); err == nil {
			t.Fatal("accepted a non-256-bit key")
		}
	}
	if _, err := cipher.Encrypt(id, "invalid"); err == nil {
		t.Fatal("accepted invalid token")
	}
	if _, err := (*LinkCipher)(nil).Encrypt(id, token); err == nil {
		t.Fatal("missing cipher accepted")
	}
}
