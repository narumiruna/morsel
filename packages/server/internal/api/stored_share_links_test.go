package api

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/narumiruna/morsel/packages/server/internal/share"
)

func TestCreateRetainsOriginalLink(t *testing.T) {
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
	token := params.LinkToken
	hash, err := share.HashToken(token)
	if err != nil || hash != params.TokenHash || result.URL != "https://morsel.example/#/s/"+token {
		t.Fatalf("retained wrong link: %v", err)
	}
	if bytes.Contains(logs.Bytes(), []byte(token)) {
		t.Fatal("logs contain a capability")
	}
}
