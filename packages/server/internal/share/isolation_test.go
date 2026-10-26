package share

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/packages/server/internal/testdb"
)

func TestAccountIsolationQueries(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	accounts := []uuid.UUID{testdb.Account(t, pool), testdb.Account(t, pool)}
	fixtures := map[uuid.UUID][]AdminMetadata{}
	for ai, accountID := range accounts {
		for n := 0; n < 16; n++ {
			item := AdminMetadata{ID: uuid.New(), Label: "Target", CreatedAt: time.Date(2020, 1, 1, 0, 0, n+ai, 0, time.UTC), ViewCount: int64(n % 3), Status: "active"}
			if n%2 == 0 {
				item.Label = "Other"
			}
			switch n % 4 {
			case 1:
				item.Status = "revoked"
				item.RevokedAt = &item.CreatedAt
			case 2:
				item.Status = "expired"
				item.ExpiresAt = &item.CreatedAt
			case 3:
				item.Status = "view_limit_exhausted"
				item.MaxViews = &item.ViewCount
				if item.ViewCount == 0 {
					item.ViewCount = 1
				}
			}
			_, err := pool.Exec(ctx, `INSERT INTO shares(account_id,id,token_hash,content,admin_label,created_at,view_count,revoked_at,expires_at,max_views)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, accountID, item.ID, uniqueHashBytes(t), "private "+accountID.String(), item.Label, item.CreatedAt, item.ViewCount, item.RevokedAt, item.ExpiresAt, item.MaxViews)
			if err != nil {
				t.Fatal(err)
			}
			fixtures[accountID] = append(fixtures[accountID], item)
		}
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, accountID := range accounts {
		r := NewAdminRepository(tx, accountID)
		for _, sort := range []string{"newest", "oldest", "most_views", "least_views"} {
			for _, status := range []string{"all", "active", "revoked", "expired", "view_limit_exhausted"} {
				for _, q := range []string{"", "target", "absent"} {
					t.Run(fmt.Sprintf("%s/%s/%s/%s", accountID, sort, status, q), func(t *testing.T) {
						var want []AdminMetadata
						for _, item := range fixtures[accountID] {
							if (status == "all" || item.Status == status) && strings.Contains(strings.ToLower(item.Label), q) {
								want = append(want, item)
							}
						}
						slices.SortFunc(want, func(a, b AdminMetadata) int {
							cmp := 0
							if adminViewSort(sort) {
								if a.ViewCount < b.ViewCount {
									cmp = -1
								} else if a.ViewCount > b.ViewCount {
									cmp = 1
								}
							}
							if cmp == 0 {
								cmp = a.CreatedAt.Compare(b.CreatedAt)
							}
							if cmp == 0 {
								cmp = strings.Compare(a.ID.String(), b.ID.String())
							}
							if sort == "newest" || sort == "most_views" {
								return -cmp
							}
							return cmp
						})
						cursor, seen := "", 0
						for {
							page, err := r.List(ctx, AdminListParams{Sort: sort, Status: status, Q: q, Limit: 2, Cursor: cursor})
							if err != nil || page.MatchingCount != int64(len(want)) {
								t.Fatalf("page=%+v err=%v", page, err)
							}
							for _, item := range page.Items {
								if seen >= len(want) || item.ID != want[seen].ID {
									t.Fatalf("foreign or unordered row: %+v", item)
								}
								seen++
							}
							cursor = page.NextCursor
							if cursor == "" {
								break
							}
							if seen > len(want) {
								t.Fatal("pagination did not finish")
							}
						}
						if seen != len(want) {
							t.Fatalf("got %d rows, want %d", seen, len(want))
						}
					})
				}
			}
		}
	}
	a, b := NewAdminRepository(tx, accounts[0]), NewAdminRepository(tx, accounts[1])
	page, err := a.List(ctx, AdminListParams{Limit: 1})
	if err != nil || page.NextCursor == "" {
		t.Fatalf("cursor: %+v %v", page, err)
	}
	if _, err := b.List(ctx, AdminListParams{Limit: 1, Cursor: page.NextCursor}); !errors.Is(err, ErrInvalidAdminParams) {
		t.Fatalf("foreign cursor: %v", err)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(page.NextCursor)
	var cursor adminCursor
	if err := json.Unmarshal(raw, &cursor); err != nil {
		t.Fatal(err)
	}
	for _, version := range []int{1, 2} {
		cursor.Version = version
		raw, _ := json.Marshal(cursor)
		if _, err := a.List(ctx, AdminListParams{Cursor: base64.RawURLEncoding.EncodeToString(raw)}); !errors.Is(err, ErrInvalidAdminParams) {
			t.Fatalf("accepted v%d: %v", version, err)
		}
	}
	// A cursor is not an authorization credential. Even forged owner and row
	// metadata must not expose rows outside the repository's account.
	cursor.Version, cursor.AccountID = 3, accounts[1]
	raw, _ = json.Marshal(cursor)
	forged, err := b.List(ctx, AdminListParams{Cursor: base64.RawURLEncoding.EncodeToString(raw)})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range forged.Items {
		if !slices.ContainsFunc(fixtures[accounts[1]], func(own AdminMetadata) bool { return own.ID == item.ID }) {
			t.Fatal("forged cursor exposed foreign row")
		}
	}
}

func uniqueHashBytes(t *testing.T) []byte {
	hash := uniqueHash(t)
	return hash[:]
}

func TestAccountIsolationPendingLabelsAndManagement(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	aID, bID := testdb.Account(t, pool), testdb.Account(t, pool)
	repo := NewPostgresRepository(pool)
	token, hash, err := (TokenGenerator{}).Generate()
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.New()
	if _, err := repo.Create(ctx, CreateParams{AccountID: bID, ID: id, TokenHash: hash, LinkToken: token, Content: "private B"}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Create(ctx, CreateParams{ID: uuid.New(), TokenHash: uniqueHash(t)}); err == nil {
		t.Fatal("missing owner accepted")
	}
	if _, err := repo.Create(ctx, CreateParams{AccountID: uuid.New(), ID: uuid.New(), TokenHash: uniqueHash(t)}); err == nil {
		t.Fatal("unknown owner accepted")
	}
	if _, err := pool.Exec(ctx, `UPDATE shares SET admin_label=NULL WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	a, b := NewAdminRepository(tx, aID), NewAdminRepository(tx, bID)
	for _, q := range []string{"", "absent"} {
		if page, err := a.List(ctx, AdminListParams{Q: q}); err != nil || page.MatchingCount != 0 {
			t.Fatalf("foreign pending label: %+v %v", page, err)
		}
		if _, err := b.List(ctx, AdminListParams{Q: q}); !errors.Is(err, ErrLabelBackfillRequired) {
			t.Fatalf("own pending label: %v", err)
		}
	}
	for _, foreign := range []uuid.UUID{id, uuid.New()} {
		if _, err := a.Detail(ctx, foreign); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign detail: %v", err)
		}
		if _, _, err := a.Link(ctx, foreign); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign link: %v", err)
		}
		if _, err := a.VerifyToken(ctx, foreign, hash); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign token verification: %v", err)
		}
		if found, err := a.Revoke(ctx, foreign); err != nil || found {
			t.Fatalf("foreign revoke: %v %v", found, err)
		}
	}
	unbound := NewAdminRepository(tx, uuid.Nil)
	if _, err := unbound.List(ctx, AdminListParams{}); err == nil {
		t.Fatal("unbound list succeeded")
	}
	if _, err := unbound.Detail(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbound detail: %v", err)
	}
	if _, _, err := unbound.Link(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbound link: %v", err)
	}
	if _, err := unbound.VerifyToken(ctx, id, hash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbound token verification: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if found, err := repo.Revoke(ctx, aID, id); err != nil || found {
		t.Fatalf("foreign Bearer revoke: %v %v", found, err)
	}
	if found, err := repo.Revoke(ctx, uuid.Nil, id); err == nil || found {
		t.Fatal("unbound revoke succeeded")
	}
	if _, err := repo.Consume(ctx, hash); err != nil {
		t.Fatalf("public read after foreign management: %v", err)
	}
	if n := testdb.Count(t, pool, `SELECT view_count FROM shares WHERE id=$1 AND revoked_at IS NULL`, id); n != 1 {
		t.Fatalf("public state=%d", n)
	}
}
