package auth

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/share"
)

func TestAccountShareViewSortPaginationAndCursorErrors(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	if _, err := pool.Exec(t.Context(), `INSERT INTO shares(account_id,id,token_hash,content,admin_label,created_at,view_count,revoked_at)
 SELECT (SELECT id FROM accounts), md5(n::text)::uuid,sha256(convert_to(n::text,'UTF8')),'content',
 CASE WHEN n=6 THEN 'Other' ELSE 'Target' END,'2020-01-01Z',n%3,
 CASE WHEN n=7 THEN now() ELSE NULL END FROM generate_series(1,7) n`); err != nil {
		t.Fatal(err)
	}
	for _, sort := range []string{"most_views", "least_views"} {
		t.Run(sort, func(t *testing.T) {
			path := "/v1/account/shares?sort=" + sort + "&q=+target+&status=active&limit=2"
			cursor := ""
			seen := map[uuid.UUID]bool{}
			previous := int64(-1)
			for pageNum := 0; ; pageNum++ {
				if pageNum > 3 {
					t.Fatal("pagination did not finish")
				}
				requestPath := path
				if cursor != "" {
					requestPath += "&cursor=" + url.QueryEscape(cursor)
				}
				w := b.request("GET", requestPath, nil)
				requireStatus(t, w, 200)
				assertShareNoStore(t, w)
				var page share.AdminPage
				if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || page.MatchingCount != 5 {
					t.Fatalf("page: %s %v", w.Body.String(), err)
				}
				for _, item := range page.Items {
					if seen[item.ID] || item.Label != "Target" || item.Status != "active" || (previous >= 0 && ((sort == "most_views" && item.ViewCount > previous) || (sort == "least_views" && item.ViewCount < previous))) {
						t.Fatalf("unexpected item: %+v after count %d", item, previous)
					}
					seen[item.ID], previous = true, item.ViewCount
				}
				if pageNum == 0 {
					for _, mismatch := range []string{"sort=newest&q=target&status=active", "sort=most_views&q=different&status=active", "sort=" + sort + "&q=target&status=revoked"} {
						requireStatus(t, b.request("GET", "/v1/account/shares?"+mismatch+"&cursor="+url.QueryEscape(page.NextCursor), nil), 400)
					}
					raw, err := base64.RawURLEncoding.DecodeString(page.NextCursor)
					if err != nil {
						t.Fatal(err)
					}
					var fields map[string]json.RawMessage
					if err := json.Unmarshal(raw, &fields); err != nil {
						t.Fatal(err)
					}
					for _, count := range []string{"", "null", "-1", `"invalid"`} {
						delete(fields, "view_count")
						if count != "" {
							fields["view_count"] = json.RawMessage(count)
						}
						malformed, _ := json.Marshal(fields)
						requireStatus(t, b.request("GET", path+"&cursor="+base64.RawURLEncoding.EncodeToString(malformed), nil), 400)
					}
				}
				cursor = page.NextCursor
				if cursor == "" {
					break
				}
			}
			if len(seen) != 5 {
				t.Fatalf("listed %d shares", len(seen))
			}
		})
	}
}
