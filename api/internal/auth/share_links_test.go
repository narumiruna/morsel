package auth

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/share"
)

func TestVerifyAccountShareLink(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	ctx := t.Context()
	// Link verification is non-consuming and does not need fresh verification.
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET verified_at=clock_timestamp()-interval '13 hours'`); err != nil {
		t.Fatal(err)
	}
	repository := share.NewPostgresRepository(pool)
	for _, preview := range []bool{false, true} {
		token, hash, err := (share.TokenGenerator{}).Generate()
		if err != nil {
			t.Fatal(err)
		}
		otherToken, _, err := (share.TokenGenerator{}).Generate()
		if err != nil {
			t.Fatal(err)
		}
		params := share.CreateParams{ID: uuid.New(), TokenHash: hash, Content: "# Link test"}
		if preview {
			params.Preview = &share.PreviewMetadata{Title: "Link test", Description: "Summary"}
		}
		if _, err := repository.Create(ctx, params); err != nil {
			t.Fatal(err)
		}
		path := "/v1/account/shares/" + params.ID.String() + "/link"
		body := []byte(`{"token":"` + token + `"}`)
		want := s.origin + "/#/s/" + token
		if preview {
			want = s.origin + "/s/" + token
		}
		for _, mutation := range []string{
			"",
			"UPDATE shares SET expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
			"UPDATE shares SET expires_at=NULL,max_views=1,view_count=1 WHERE id=$1",
			"UPDATE shares SET revoked_at=clock_timestamp() WHERE id=$1",
		} {
			if mutation != "" {
				if _, err := pool.Exec(ctx, mutation, params.ID); err != nil {
					t.Fatal(err)
				}
			}
			var before, after string
			if err := pool.QueryRow(ctx, "SELECT to_jsonb(shares)::text FROM shares WHERE id=$1", params.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			w := b.request("POST", path, body)
			requireStatus(t, w, 200)
			assertShareNoStore(t, w)
			var result map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result["share_url"] != want || len(result) != 1 {
				t.Fatalf("canonical URL: %s %v", w.Body.String(), err)
			}
			if err := pool.QueryRow(ctx, "SELECT to_jsonb(shares)::text FROM shares WHERE id=$1", params.ID).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatal("link verification changed share data or availability")
			}
		}
		for _, payload := range []string{`{}`, `{"token":"invalid"}`, `{"token":null}`, `{"token":"` + token + `","extra":true}`, string(body) + `{}`} {
			requireStatus(t, b.request("POST", path, []byte(payload)), 400)
		}
		w := b.request("POST", path, []byte(`{"token":"`+otherToken+`"}`))
		requireStatus(t, w, 404)
		if strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), otherToken) {
			t.Fatal("mismatch disclosed a capability")
		}
		requireStatus(t, b.request("POST", "/v1/account/shares/"+uuid.NewString()+"/link", body), 404)
		requireStatus(t, b.request("POST", "/v1/account/shares/invalid/link", body), 400)
		requireStatus(t, newBrowser(s).request("POST", path, body), 401)
		csrf := b.csrf
		b.csrf = "wrong"
		requireStatus(t, b.request("POST", path, body), 403)
		b.csrf = csrf
		for _, origins := range [][]string{nil, {"https://evil.example"}, {s.origin, s.origin}} {
			r := httptest.NewRequest("POST", path, strings.NewReader(string(body)))
			r.Header["Origin"] = origins
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", b.csrf)
			for _, cookie := range b.cookies {
				r.AddCookie(cookie)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			requireStatus(t, w, 403)
		}
		r := httptest.NewRequest("POST", path, strings.NewReader(string(body)))
		r.Header.Set("Origin", s.origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+randomToken())
		w = httptest.NewRecorder()
		s.ServeHTTP(w, r)
		requireStatus(t, w, 401)
	}
}
