package auth

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestStoredAccountShareLink(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '13 hours'`); err != nil {
		t.Fatal(err)
	}
	repository := share.NewPostgresRepository(pool)
	for _, preview := range []bool{false, true} {
		token, hash, err := (share.TokenGenerator{}).Generate()
		if err != nil {
			t.Fatal(err)
		}
		id := uuid.New()
		params := share.CreateParams{AccountID: testdb.AccountID(t, pool), ID: id, TokenHash: hash, LinkToken: token, Content: "# Stored link"}
		if preview {
			params.Preview = &share.PreviewMetadata{Title: "Stored link", Description: "Description"}
		}
		if _, err := repository.Create(ctx, params); err != nil {
			t.Fatal(err)
		}
		path := "/v1/account/shares/" + id.String() + "/link"
		want := share.PublicURL(s.publicURL, token, preview)
		for _, mutation := range []string{
			"",
			"UPDATE shares SET expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
			"UPDATE shares SET expires_at=NULL,max_views=1,view_count=1 WHERE id=$1",
			"UPDATE shares SET revoked_at=clock_timestamp() WHERE id=$1",
		} {
			if mutation != "" {
				if _, err := pool.Exec(ctx, mutation, id); err != nil {
					t.Fatal(err)
				}
			}
			var before, after string
			if err := pool.QueryRow(ctx, "SELECT to_jsonb(shares)::text FROM shares WHERE id=$1", id).Scan(&before); err != nil {
				t.Fatal(err)
			}
			w := b.request("GET", path, nil)
			requireStatus(t, w, 200)
			assertShareNoStore(t, w)
			var result map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result["share_url"] != want || len(result) != 1 {
				t.Fatalf("wrong stored URL: %v", err)
			}
			if err := pool.QueryRow(ctx, "SELECT to_jsonb(shares)::text FROM shares WHERE id=$1", id).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatal("retrieval changed share data")
			}
		}
		for _, metadataPath := range []string{"/v1/account/shares", "/v1/account/shares/" + id.String()} {
			w := b.request("GET", metadataPath, nil)
			requireStatus(t, w, 200)
			if strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), "token_hash") || strings.Contains(w.Body.String(), "link_token") || !strings.Contains(w.Body.String(), `"link_available":true`) {
				t.Fatal("metadata must expose only link availability")
			}
		}
		requireStatus(t, newBrowser(s).request("GET", path, nil), 401)
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+randomToken())
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		requireStatus(t, w, 401)
		// A retained token must match the share's public authorization hash.
		otherID := uuid.New()
		_, otherHash, _ := (share.TokenGenerator{}).Generate()
		if _, err := repository.Create(ctx, share.CreateParams{AccountID: testdb.AccountID(t, pool), ID: otherID, TokenHash: otherHash, LinkToken: token}); err != nil {
			t.Fatal(err)
		}
		w = b.request("GET", "/v1/account/shares/"+otherID.String()+"/link", nil)
		requireStatus(t, w, 503)
		assertShareNoStore(t, w)
		if strings.Contains(w.Body.String(), token) {
			t.Fatal("error disclosed capability")
		}
		if _, err := pool.Exec(ctx, "UPDATE shares SET link_token=$2 WHERE id=$1", id, "invalid-token"); err != nil {
			t.Fatal(err)
		}
		w = b.request("GET", path, nil)
		requireStatus(t, w, 503)
		assertShareNoStore(t, w)
		if strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), "invalid-token") {
			t.Fatal("invalid stored token disclosed capability")
		}
		if _, err := pool.Exec(ctx, "UPDATE shares SET link_token=NULL WHERE id=$1", id); err != nil {
			t.Fatal(err)
		}
		w = b.request("GET", path, nil)
		requireStatus(t, w, 404)
		assertShareNoStore(t, w)
		if !strings.Contains(w.Body.String(), "link_unavailable") {
			t.Fatal("missing legacy explanation")
		}
		w = b.request("GET", "/v1/account/shares/"+id.String(), nil)
		if !strings.Contains(w.Body.String(), `"link_available":false`) {
			t.Fatal("legacy link incorrectly available")
		}
	}
	requireStatus(t, b.request("GET", "/v1/account/shares/"+uuid.NewString()+"/link", nil), 404)
	requireStatus(t, b.request("GET", "/v1/account/shares/invalid/link", nil), 400)
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, b.request("GET", "/v1/account/shares/"+uuid.NewString()+"/link", nil), 401)
}
