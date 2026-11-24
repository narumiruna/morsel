package share

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
)

const (
	TokenBytes        = 32
	TokenLength       = legacyTokenLength
	legacyTokenLength = 43
	hexTokenLength    = TokenBytes * 2
)

type TokenGenerator struct {
	Reader io.Reader
}

func (g TokenGenerator) Generate() (string, [sha256.Size]byte, error) {
	reader := g.Reader
	if reader == nil {
		reader = rand.Reader
	}
	buf := make([]byte, TokenBytes)
	if _, err := io.ReadFull(reader, buf); err != nil {
		return "", [sha256.Size]byte{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	return token, sha256.Sum256([]byte(token)), nil
}

func HashToken(token string) ([sha256.Size]byte, error) {
	switch len(token) {
	case legacyTokenLength:
		raw, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil || len(raw) != TokenBytes || base64.RawURLEncoding.EncodeToString(raw) != token {
			return [sha256.Size]byte{}, errors.New("invalid token encoding")
		}
	case hexTokenLength:
		for _, char := range token {
			if !('0' <= char && char <= '9') && !('a' <= char && char <= 'f') {
				return [sha256.Size]byte{}, errors.New("invalid token encoding")
			}
		}
	default:
		return [sha256.Size]byte{}, errors.New("invalid token length")
	}
	return sha256.Sum256([]byte(token)), nil
}
