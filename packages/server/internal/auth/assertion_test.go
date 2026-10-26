package auth

import (
	"encoding/json"
	"testing"

	"github.com/narumiruna/morsel/packages/server/internal/testdb"
)

func TestLoginRejectsInvalidAssertions(t *testing.T) {
	for _, scenario := range []string{"challenge", "RP ID", "signature", "credential ID", "user handle"} {
		t.Run(scenario, func(t *testing.T) {
			s, pool := testService(t)
			b, enrolled := enrollAuthenticator(t, s, pool)
			w := b.request("POST", "/v1/auth/login/begin", []byte(`{}`))
			requireStatus(t, w, 200)
			options := challenge(t, w.Body.Bytes())
			a := *enrolled
			switch scenario {
			case "challenge":
				options["challenge"] = randomToken()
			case "RP ID":
				options["rpId"] = "other.example"
			case "signature":
				a.key = newAuthenticator(t).key
			case "credential ID":
				a.id = randomBytes(32)
			case "user handle":
				a.user = randomBytes(16)
			}
			body := a.assertion(t, encode(t, map[string]any{"publicKey": options}), s.origin, true)
			response := b.request("POST", "/v1/auth/login/finish", body)
			requireStatus(t, response, 400)
			var failure map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || failure["code"] != "invalid_credential" {
				t.Fatalf("unexpected assertion failure: %v", err)
			}
			if testdb.Count(t, pool, `SELECT count(*) FROM auth_sessions`) != 1 {
				t.Fatal("invalid assertion created a session")
			}
			// Every failed assertion consumes its browser flow.
			requireStatus(t, b.request("POST", "/v1/auth/login/finish", body), 400)
		})
	}
}
