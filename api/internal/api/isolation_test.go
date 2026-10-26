package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/auth"
	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestTwoAccountShareHTTPIsolation(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	origin, _ := url.Parse("http://localhost:5173")
	accountService, err := auth.NewService(pool, origin)
	if err != nil {
		t.Fatal(err)
	}
	type identity struct {
		id            uuid.UUID
		session, csrf string
		keys          []string
	}
	identities := make([]identity, 2)
	for n := range identities {
		person := identity{id: testdb.Account(t, pool), session: uuid.NewString(), csrf: uuid.NewString()}
		hash := sha256.Sum256([]byte(person.session))
		if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(token_hash,account_id,generation,csrf_token,expires_at)
			VALUES($1,$2,1,$3,clock_timestamp()+interval '1 day')`, hash[:], person.id, person.csrf); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			key := uuid.NewString()
			hash := sha256.Sum256([]byte(key))
			if _, err := pool.Exec(ctx, `INSERT INTO api_keys(id,account_id,name,prefix,token_hash)
				VALUES($1,$2,'fixture','prefix',$3)`, uuid.New(), person.id, hash[:]); err != nil {
				t.Fatal(err)
			}
			person.keys = append(person.keys, key)
		}
		identities[n] = person
	}
	repo := share.NewPostgresRepository(pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewRouter(NewService(repo, share.TokenGenerator{}, origin, 100, logger), RouterConfig{
		Authenticator: accountService, Account: accountService, Logger: logger, MaxRequestBody: 4096, RequestTimeout: 5 * time.Second,
	})
	perform := func(person *identity, key, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin.String())
		// This is untrusted input, never an account selector.
		r.Header.Set("X-Morsel-Account-ID", identities[1].id.String())
		if person != nil {
			r.AddCookie(&http.Cookie{Name: "morsel_session", Value: person.session})
			r.Header.Set("X-CSRF-Token", person.csrf)
		}
		if key != "" {
			r.Header.Set("Authorization", "Bearer "+key)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	check := func(w *httptest.ResponseRecorder, status int, person *identity) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("status=%d want=%d body=%s", w.Code, status, w.Body.String())
		}
		if person != nil && status < 300 && w.Header().Get("X-Morsel-Account-ID") != person.id.String() {
			t.Fatalf("wrong authorized identity: %v", w.Header())
		}
	}
	type createdShare struct {
		ID     uuid.UUID `json:"id"`
		URL    string    `json:"share_url"`
		Status string    `json:"-"`
		Label  string    `json:"-"`
	}
	created := make([][]createdShare, 2)
	for n := range identities {
		for index := range 8 {
			w := perform(nil, identities[n].keys[0], "POST", "/v1/shares", `{"content":"# Target"}`)
			check(w, 201, nil)
			var result createdShare
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			result.Status = []string{"active", "revoked", "expired", "view_limit_exhausted"}[index%4]
			result.Label = "Target"
			// Interleave account history, status precedence, and view counts.
			if _, err := pool.Exec(ctx, `UPDATE shares SET created_at=$2,view_count=$3,
				revoked_at=CASE WHEN $4='revoked' THEN $2::timestamptz END,
				expires_at=CASE WHEN $4 IN ('revoked','expired') THEN $2::timestamptz END,
				max_views=CASE WHEN $4='view_limit_exhausted' THEN $3::bigint END WHERE id=$1`,
				result.ID, time.Date(2020, 1, 1, 0, 0, index*2+n, 0, time.UTC), int64(index%3+1), result.Status); err != nil {
				t.Fatal(err)
			}
			created[n] = append(created[n], result)
			if count := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE id=$1 AND account_id=$2`, result.ID, identities[n].id); count != 1 {
				t.Fatal("creation ignored authenticated owner")
			}
		}
	}
	a, b := &identities[0], &identities[1]
	for _, forged := range []string{
		`{"content":"forged","account_id":"` + b.id.String() + `"}`,
		`{"content":"forged","owner":"` + b.id.String() + `"}`,
	} {
		check(perform(nil, a.keys[0], "POST", "/v1/shares", forged), 400, nil)
	}
	// A query or header must not assign ownership to B.
	w := perform(nil, a.keys[0], "POST", "/v1/shares?account_id="+b.id.String(), `{"content":"query owner"}`)
	check(w, 201, nil)
	var queryShare createdShare
	if err := json.Unmarshal(w.Body.Bytes(), &queryShare); err != nil {
		t.Fatal(err)
	}
	if n := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE id=$1 AND account_id=$2`, queryShare.ID, a.id); n != 1 {
		t.Fatal("untrusted owner override")
	}
	queryShare.Status, queryShare.Label = "active", "query owner"
	created[0] = append(created[0], queryShare)
	for ai := range identities {
		person := &identities[ai]
		for _, sort := range []string{"newest", "oldest", "most_views", "least_views"} {
			for _, status := range []string{"all", "active", "expired", "revoked", "view_limit_exhausted"} {
				for _, q := range []string{"", "target", "absent"} {
					cursor, seen := "", 0
					for {
						path := "/v1/account/shares?limit=1&sort=" + sort + "&status=" + status + "&q=" + q
						if cursor != "" {
							path += "&cursor=" + url.QueryEscape(cursor)
						}
						w := perform(person, "", "GET", path, "")
						check(w, 200, person)
						var page share.AdminPage
						if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
							t.Fatal(err)
						}
						want := 0
						for _, own := range created[ai] {
							if (status == "all" || status == own.Status) && strings.Contains(strings.ToLower(own.Label), q) {
								want++
							}
						}
						if page.MatchingCount != int64(want) {
							t.Fatalf("foreign matching count: %+v", page)
						}
						for _, item := range page.Items {
							if n := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE id=$1 AND account_id=$2`, item.ID, person.id); n != 1 {
								t.Fatal("foreign list row")
							}
							seen++
						}
						cursor = page.NextCursor
						if cursor == "" {
							if seen != want {
								t.Fatal("missing own rows")
							}
							break
						}
						if seen > want {
							t.Fatal("pagination loop")
						}
					}
				}
			}
		}
	}
	w = perform(a, "", "GET", "/v1/account/shares?limit=1", "")
	check(w, 200, a)
	var page share.AdminPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	check(perform(b, "", "GET", "/v1/account/shares?limit=1&cursor="+url.QueryEscape(page.NextCursor), ""), 400, nil)
	for _, version := range []int{1, 2} {
		raw, _ := base64.RawURLEncoding.DecodeString(page.NextCursor)
		var cursor map[string]any
		if err := json.Unmarshal(raw, &cursor); err != nil {
			t.Fatal(err)
		}
		cursor["v"] = version
		raw, _ = json.Marshal(cursor)
		check(perform(a, "", "GET", "/v1/account/shares?cursor="+base64.RawURLEncoding.EncodeToString(raw), ""), 400, nil)
	}
	foreign := created[1][0]
	token := foreign.URL[strings.LastIndex(foreign.URL, "/")+1:]
	// Pending metadata must not reveal the presence of a foreign share.
	if _, err := pool.Exec(ctx, `UPDATE shares SET admin_label=NULL WHERE id=$1`, foreign.ID); err != nil {
		t.Fatal(err)
	}
	check(perform(a, "", "GET", "/v1/account/shares?q=absent", ""), 200, a)
	check(perform(b, "", "GET", "/v1/account/shares?q=absent", ""), 503, nil)
	for _, endpoint := range []struct{ method, suffix, key string }{
		{"GET", "", ""}, {"DELETE", "", ""}, {"GET", "/link", ""}, {"POST", "/link", ""}, {"DELETE", "", a.keys[0]},
	} {
		prefix := "/v1/account/shares/"
		person := a
		if endpoint.key != "" {
			prefix = "/v1/shares/"
			person = nil
		}
		body := ""
		if endpoint.method == "POST" {
			body = `{"token":"` + token + `"}`
		}
		foreignResponse := perform(person, endpoint.key, endpoint.method, prefix+foreign.ID.String()+endpoint.suffix, body)
		missingResponse := perform(person, endpoint.key, endpoint.method, prefix+uuid.NewString()+endpoint.suffix, body)
		check(foreignResponse, 404, nil)
		check(missingResponse, 404, nil)
		if foreignResponse.Body.String() != missingResponse.Body.String() {
			t.Fatalf("foreign existence signal: %s vs %s", foreignResponse.Body.String(), missingResponse.Body.String())
		}
	}
	if n := testdb.Count(t, pool, `SELECT view_count FROM shares WHERE id=$1 AND revoked_at IS NULL`, foreign.ID); n != 1 {
		t.Fatal("foreign administration changed public state")
	}
	// Correct owner can retrieve and verify the raw capability even with a pending label.
	for _, method := range []string{"GET", "POST"} {
		body := ""
		if method == "POST" {
			body = `{"token":"` + token + `"}`
		}
		w := perform(b, "", method, "/v1/account/shares/"+foreign.ID.String()+"/link", body)
		check(w, 200, b)
		if !strings.Contains(w.Body.String(), token) {
			t.Fatal("stored capability changed")
		}
	}
	// A session for A can still use B's public capability; no owner metadata is public.
	w = perform(a, "", "GET", "/v1/shares/"+token, "")
	check(w, 200, nil)
	if strings.Contains(w.Body.String(), b.id.String()) || strings.Contains(w.Body.String(), "display_name") || w.Header().Get("X-Morsel-Account-ID") != "" {
		t.Fatal("public read exposed private identity")
	}
	// A second key has the same permissions as the creating key, but B's keys do not.
	owned := created[0][0]
	check(perform(nil, b.keys[0], "DELETE", "/v1/shares/"+owned.ID.String(), ""), 404, nil)
	check(perform(nil, a.keys[1], "DELETE", "/v1/shares/"+owned.ID.String(), ""), 204, nil)
	check(perform(a, "", "DELETE", "/v1/account/shares/"+owned.ID.String(), ""), 204, a)
	if _, err := pool.Exec(ctx, `UPDATE api_keys SET revoked_at=now() WHERE account_id=$1 AND token_hash=$2`, a.id, hashString(a.keys[0])); err != nil {
		t.Fatal(err)
	}
	check(perform(nil, a.keys[0], "POST", "/v1/shares", `{"content":"revoked"}`), 401, nil)
	check(perform(nil, b.keys[1], "POST", "/v1/shares", `{"content":"unaffected"}`), 201, nil)
	if n := testdb.Count(t, pool, `SELECT count(*) FROM shares WHERE id=$1 AND account_id=$2`, owned.ID, a.id); n != 1 {
		t.Fatal("key change moved ownership")
	}
}

func hashString(value string) []byte {
	hash := sha256.Sum256([]byte(value))
	return hash[:]
}

func TestShareStrictHandlersRequireTrustedPrincipal(t *testing.T) {
	repo := &repositoryStub{revokeFound: true}
	origin, _ := url.Parse("https://morsel.example/")
	service := NewService(repo, share.TokenGenerator{}, origin, 100, slog.Default())
	// Neither a missing value nor an untyped context value is trusted.
	for _, ctx := range []context.Context{context.Background(), context.WithValue(context.Background(), "account_id", uuid.New())} {
		response, err := service.CreateShare(ctx, CreateShareRequestObject{Body: &CreateShareJSONRequestBody{Content: "private"}})
		if err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		if err := response.VisitCreateShareResponse(w); err != nil {
			t.Fatal(err)
		}
		if w.Code != 401 || len(repo.created) != 0 {
			t.Fatal("missing trusted principal authorized creation")
		}
		revoked, err := service.RevokeShare(ctx, RevokeShareRequestObject{Share: uuid.New()})
		if err != nil {
			t.Fatal(err)
		}
		w = httptest.NewRecorder()
		if err := revoked.VisitRevokeShareResponse(w); err != nil {
			t.Fatal(err)
		}
		if w.Code != 401 {
			t.Fatal("missing trusted principal authorized revocation")
		}
	}
}
