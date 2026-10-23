package api

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/url"
	"testing"

	"github.com/narumiruna/morsel/api/internal/share"
)

func TestCreateFailsClosedWithoutLinkCipher(t *testing.T) {
	repository := &repositoryStub{}
	origin, _ := url.Parse("https://morsel.example/")
	service := NewService(repository, share.TokenGenerator{}, origin, 100, slog.Default(), nil)
	response, err := service.CreateShare(t.Context(), CreateShareRequestObject{Body: &CreateShareJSONRequestBody{Content: "No plaintext fallback"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(CreateShare500JSONResponse); !ok || len(repository.created) != 0 {
		t.Fatal("missing encryption must not create a hash-only share")
	}
}

func TestCreateRetainsEncryptedLink(t *testing.T) {
	repository := &repositoryStub{}
	var logs bytes.Buffer
	handler := testRouter(t, repository, nil, &logs, 100)
	w := request(t, handler, "POST", "/v1/shares", `{"content":"# Saved link"}`, "Bearer "+testAPIKey)
	if w.Code != 201 {
		t.Fatalf("creation status=%d", w.Code)
	}
	var result struct {
		URL string `json:"share_url"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	params := repository.created[0]
	token, err := testLinkCipher(t).Decrypt(params.ID, params.LinkCiphertext, params.TokenHash)
	if err != nil || result.URL != "https://morsel.example/#/s/"+token {
		t.Fatalf("retained wrong link: %v", err)
	}
	if logs.Len() > 0 && bytes.Contains(logs.Bytes(), []byte(token)) {
		t.Fatal("logs contain a capability")
	}
}
