package share

import (
	"crypto/aes"
	"crypto/cipher"
	"errors"

	"github.com/google/uuid"
)

// LinkCipher retains capabilities without storing plaintext in PostgreSQL.
// The key must be kept outside the database and shared by all server instances.
type LinkCipher struct {
	aead cipher.AEAD
}

func NewLinkCipher(key []byte) (*LinkCipher, error) {
	if len(key) != 32 {
		return nil, errors.New("share link key must contain 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCMWithRandomNonce(block)
	if err != nil {
		return nil, err
	}
	return &LinkCipher{aead: aead}, nil
}

func (c *LinkCipher) Encrypt(id uuid.UUID, token string) ([]byte, error) {
	if c == nil {
		return nil, errors.New("share link encryption is unavailable")
	}
	if _, err := HashToken(token); err != nil {
		return nil, errors.New("invalid share capability")
	}
	return c.aead.Seal(nil, nil, []byte(token), id[:]), nil
}

func (c *LinkCipher) Decrypt(id uuid.UUID, encrypted []byte, hash [32]byte) (string, error) {
	if c == nil {
		return "", errors.New("share link encryption is unavailable")
	}
	plain, err := c.aead.Open(nil, nil, encrypted, id[:])
	if err != nil {
		return "", errors.New("cannot decrypt share link")
	}
	token := string(plain)
	actual, err := HashToken(token)
	if err != nil || actual != hash {
		return "", errors.New("stored share link does not match capability hash")
	}
	return token, nil
}
