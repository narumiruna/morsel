package share

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestAdminViewSortCursorValidation(t *testing.T) {
	accountID := uuid.New()
	encode := func(raw string) string { return base64.RawURLEncoding.EncodeToString([]byte(raw)) }
	for _, sort := range []string{"most_views", "least_views"} {
		t.Run(sort, func(t *testing.T) {
			p, err := NormalizeAdminQuery(AdminListParams{Sort: sort, Status: "active", Q: " target "})
			if err != nil || p.Q != "target" {
				t.Fatalf("normalize: %+v %v", p, err)
			}
			base := fmt.Sprintf(`{"v":3,"account_id":%q,"status":"active","created_at":"2020-01-01T00:00:00Z","id":"00000000-0000-0000-0000-000000000001","sort":%q,"search_hash":%q`, accountID, sort, searchHash(p.Q))
			for _, count := range []string{"0", "42", "9223372036854775807"} {
				cursor, err := decodeAdminCursor(encode(base+`,"view_count":`+count+`}`), p, accountID)
				if err != nil || cursor.ViewCount == nil {
					t.Fatalf("valid count %s: %+v %v", count, cursor, err)
				}
			}
			for _, suffix := range []string{`}`, `,"view_count":null}`, `,"view_count":-1}`, `,"view_count":1.5}`, `,"view_count":"1"}`, `,"view_count":true}`, `,"view_count":[]}`, `,"view_count":9223372036854775808}`} {
				if _, err := decodeAdminCursor(encode(base+suffix), p, accountID); !errors.Is(err, ErrInvalidAdminParams) {
					t.Fatalf("accepted %s: %v", suffix, err)
				}
			}
			valid := encode(base + `,"view_count":0}`)
			for _, changed := range []AdminListParams{
				{Status: "all", Sort: sort, Q: p.Q},
				{Status: p.Status, Sort: sort, Q: "different"},
				{Status: p.Status, Sort: "newest", Q: p.Q},
				{Status: p.Status, Sort: "oldest", Q: p.Q},
				{Status: p.Status, Sort: map[string]string{"most_views": "least_views", "least_views": "most_views"}[sort], Q: p.Q},
			} {
				if _, err := decodeAdminCursor(valid, changed, accountID); !errors.Is(err, ErrInvalidAdminParams) {
					t.Fatalf("accepted mismatch %+v: %v", changed, err)
				}
			}
			// Creation cursors cannot be used to start a view-count continuation.
			for _, version := range []int{1, 2} {
				raw := fmt.Sprintf(`{"v":%d,"status":"active","created_at":"2020-01-01T00:00:00Z","id":"00000000-0000-0000-0000-000000000001"}`, version)
				if _, err := decodeAdminCursor(encode(raw), p, accountID); !errors.Is(err, ErrInvalidAdminParams) {
					t.Fatalf("accepted creation v%d: %v", version, err)
				}
			}
		})
	}
}

func TestAdminCreationCursorCompatibility(t *testing.T) {
	id := uuid.New()
	accountID := uuid.New()
	for _, sort := range []string{"newest", "oldest"} {
		for _, version := range []int{1, 2, 3} {
			p, _ := NormalizeAdminQuery(AdminListParams{Sort: sort})
			cursor := adminCursor{Version: version, AccountID: accountID, Status: p.Status, CreatedAt: time.Now(), ID: &id}
			if version >= 2 {
				cursor.Sort, cursor.SearchHash = sort, searchHash(p.Q)
			}
			b, _ := json.Marshal(cursor)
			if _, err := decodeAdminCursor(base64.RawURLEncoding.EncodeToString(b), p, accountID); (version == 3 && err != nil) || (version < 3 && !errors.Is(err, ErrInvalidAdminParams)) {
				t.Fatalf("creation %s v%d: %v", sort, version, err)
			}
		}
	}
}

func TestAdminViewSortPaginationFiltersAndCounts(t *testing.T) {
	pool := testdb.Open(t)
	testdb.Account(t, pool)
	ctx := t.Context()
	var fixtures []AdminMetadata
	for n := 1; n <= 137; n++ {
		item := AdminMetadata{
			ID:    uuid.MustParse(fmt.Sprintf("00000000-0000-0000-0000-%012d", n)),
			Label: "Target", CreatedAt: time.Date(2020, 1, 1+n%3, 0, 0, 0, 0, time.UTC),
			ViewCount: int64(n % 7), Status: "active",
		}
		if n%3 == 0 {
			item.Label = "Other"
		}
		switch n % 5 {
		case 0:
			item.Status = "revoked"
			revoked := item.CreatedAt
			item.RevokedAt = &revoked
		case 1:
			item.Status = "expired"
			expires := item.CreatedAt
			item.ExpiresAt = &expires
		case 2:
			item.Status = "view_limit_exhausted"
			item.ViewCount++
			maxViews := item.ViewCount
			item.MaxViews = &maxViews
		}
		if n == 137 {
			item.ViewCount = math.MaxInt64
			maxViews := item.ViewCount
			item.MaxViews = &maxViews
		}
		_, err := pool.Exec(ctx, `INSERT INTO shares(account_id,id,token_hash,content,admin_label,created_at,view_count,revoked_at,expires_at,max_views)
 VALUES((SELECT id FROM accounts),$1,$2,'content',$3,$4,$5,$6,$7,$8)`, item.ID, []byte(fmt.Sprintf("%032d", n)), item.Label, item.CreatedAt, item.ViewCount, item.RevokedAt, item.ExpiresAt, item.MaxViews)
		if err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, item)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	r := NewAdminRepository(tx, testdb.AccountID(t, pool))
	for _, sort := range []string{"most_views", "least_views"} {
		for _, status := range []string{"all", "active", "revoked", "expired", "view_limit_exhausted"} {
			for _, q := range []string{"", " tArGeT ", "absent"} {
				t.Run(sort+"/"+status+"/"+q, func(t *testing.T) {
					var want []AdminMetadata
					for _, item := range fixtures {
						if (status == "all" || status == item.Status) && strings.Contains(strings.ToLower(item.Label), strings.ToLower(strings.TrimSpace(q))) {
							want = append(want, item)
						}
					}
					slices.SortFunc(want, func(a, b AdminMetadata) int {
						cmp := 0
						if a.ViewCount < b.ViewCount {
							cmp = -1
						} else if a.ViewCount > b.ViewCount {
							cmp = 1
						} else if cmp = a.CreatedAt.Compare(b.CreatedAt); cmp == 0 {
							cmp = strings.Compare(a.ID.String(), b.ID.String())
						}
						if sort == "most_views" {
							cmp = -cmp
						}
						return cmp
					})
					var got []AdminMetadata
					cursor := ""
					for pageNum := 0; ; pageNum++ {
						if pageNum > len(fixtures) {
							t.Fatal("pagination did not finish")
						}
						page, err := r.List(ctx, AdminListParams{Sort: sort, Status: status, Q: q, Limit: 9, Cursor: cursor})
						if err != nil || page.MatchingCount != int64(len(want)) {
							t.Fatalf("count/page: %+v %v", page, err)
						}
						got = append(got, page.Items...)
						cursor = page.NextCursor
						if cursor == "" {
							break
						}
						if len(page.Items) != 9 || len(cursor) > 512 {
							t.Fatalf("invalid continuation: %+v", page)
						}
					}
					if len(got) != len(want) {
						t.Fatalf("items=%d want=%d", len(got), len(want))
					}
					for i := range want {
						if got[i].ID != want[i].ID || got[i].ViewCount != want[i].ViewCount {
							t.Fatalf("item %d: %+v want %+v", i, got[i], want[i])
						}
					}
				})
			}
		}
	}
}
