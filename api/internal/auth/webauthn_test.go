package auth

// These fixtures emulate a resident ES256 authenticator. Production verification
// remains entirely in go-webauthn. Tests sign actual ceremony challenges.
import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"github.com/google/uuid"
	"testing"

	"github.com/fxamacker/cbor/v2"
	"github.com/jackc/pgx/v5/pgxpool"
)

type authenticator struct {
	key      *ecdsa.PrivateKey
	id, user []byte
	counter  uint32
}

func newAuthenticator(t *testing.T) *authenticator {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &authenticator{key: key, id: randomBytes(32)}
}
func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
func encode(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func challenge(t *testing.T, options []byte) map[string]any {
	t.Helper()
	var v struct {
		PublicKey map[string]any `json:"publicKey"`
	}
	if err := json.Unmarshal(options, &v); err != nil {
		t.Fatal(err)
	}
	if v.PublicKey == nil {
		t.Fatal("missing publicKey")
	}
	return v.PublicKey
}
func (a *authenticator) registration(t *testing.T, options []byte, origin string, uv bool) []byte {
	t.Helper()
	o := challenge(t, options)
	u := o["user"].(map[string]any)
	var err error
	a.user, err = base64.RawURLEncoding.DecodeString(u["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	rp := o["rp"].(map[string]any)["id"].(string)
	client := encode(t, map[string]any{"type": "webauthn.create", "challenge": o["challenge"], "origin": origin, "crossOrigin": false})
	cose, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: a.key.X.FillBytes(make([]byte, 32)), -3: a.key.Y.FillBytes(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	rpHash := sha256.Sum256([]byte(rp))
	data := append([]byte{}, rpHash[:]...)
	flags := byte(0x41)
	if uv {
		flags |= 4
	}
	data = append(data, flags)
	data = append(data, 0, 0, 0, 0)
	data = append(data, make([]byte, 16)...)
	data = append(data, byte(len(a.id)>>8), byte(len(a.id)))
	data = append(data, a.id...)
	data = append(data, cose...)
	att, err := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": data})
	if err != nil {
		t.Fatal(err)
	}
	return encode(t, map[string]any{"id": b64(a.id), "rawId": b64(a.id), "type": "public-key", "response": map[string]any{"clientDataJSON": b64(client), "attestationObject": b64(att), "transports": []string{"internal"}}, "clientExtensionResults": map[string]any{}})
}
func (a *authenticator) assertion(t *testing.T, options []byte, origin string, uv bool) []byte {
	t.Helper()
	o := challenge(t, options)
	rp := o["rpId"].(string)
	client := encode(t, map[string]any{"type": "webauthn.get", "challenge": o["challenge"], "origin": origin, "crossOrigin": false})
	rpHash := sha256.Sum256([]byte(rp))
	data := append([]byte{}, rpHash[:]...)
	flags := byte(1)
	if uv {
		flags |= 4
	}
	data = append(data, flags)
	a.counter++
	data = binary.BigEndian.AppendUint32(data, a.counter)
	clientHash := sha256.Sum256(client)
	signed := append(append([]byte{}, data...), clientHash[:]...)
	digest := sha256.Sum256(signed)
	sig, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return encode(t, map[string]any{"id": b64(a.id), "rawId": b64(a.id), "type": "public-key", "response": map[string]any{"clientDataJSON": b64(client), "authenticatorData": b64(data), "signature": b64(sig), "userHandle": b64(a.user)}, "clientExtensionResults": map[string]any{}})
}
func enroll(t *testing.T, s *Service, pool *pgxpool.Pool) *browser {
	b, _ := enrollAuthenticator(t, s, pool)
	return b
}
func enrollAuthenticator(t *testing.T, s *Service, pool *pgxpool.Pool) (*browser, *authenticator) {
	t.Helper()
	token, err := IssueGrant(t.Context(), pool, "setup", uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	b := newBrowser(s)
	a := newAuthenticator(t)
	w := b.request("POST", "/v1/auth/setup/begin", encode(t, map[string]string{"token": token, "name": "Primary"}))
	requireStatus(t, w, 200)
	credential := a.registration(t, w.Body.Bytes(), s.origin, true)
	w = b.request("POST", "/v1/auth/setup/finish", credential)
	requireStatus(t, w, 200)
	if b.state(t)["authenticated"] != true || b.csrf == "" {
		t.Fatal("setup did not establish session")
	}
	return b, a
}
func addPasskey(t *testing.T, b *browser, name string) *authenticator {
	t.Helper()
	a := newAuthenticator(t)
	w := b.request("POST", "/v1/auth/passkey/begin", encode(t, map[string]string{"name": name}))
	requireStatus(t, w, 200)
	credential := a.registration(t, w.Body.Bytes(), b.s.origin, true)
	requireStatus(t, b.request("POST", "/v1/auth/passkey/finish", credential), 200)
	return a
}
func verify(t *testing.T, b *browser, a *authenticator) {
	t.Helper()
	w := b.request("POST", "/v1/auth/verify/begin", []byte(`{}`))
	requireStatus(t, w, 200)
	assertion := a.assertion(t, w.Body.Bytes(), b.s.origin, true)
	requireStatus(t, b.request("POST", "/v1/auth/verify/finish", assertion), 200)
}
