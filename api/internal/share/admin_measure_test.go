package share

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestAdminQueryDiscovery(t *testing.T) {
	pool := testdb.Open(t)
	accountID, otherID := testdb.Account(t, pool), testdb.Account(t, pool)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `INSERT INTO shares(account_id,id,token_hash,content,admin_label,created_at,revoked_at,view_count)
  SELECT CASE WHEN n%2=0 THEN $1::uuid ELSE $2::uuid END, md5(n::text)::uuid,sha256(convert_to(n::text,'UTF8')),
  '# **Résumé** [界](https://example.com)'||repeat(E'\nparagraph [link](https://example.com).',1600),
  'Résumé 界 code '||n,'2020-01-01Z'::timestamptz+n*interval '1 second',
  CASE WHEN n%5=0 THEN now() ELSE NULL END,n%97 FROM generate_series(1,10000) n`, accountID, otherID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ANALYZE shares`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		status, q, sort string
		cursor          bool
	}{
		{"all", "RÉSUMÉ", "newest", false}, {"active", "界", "oldest", false}, {"revoked", "absent", "newest", false}, {"all", "RÉSUMÉ", "oldest", true},
		{"all", "RÉSUMÉ", "most_views", false}, {"active", "界", "least_views", true},
	} {
		var before *time.Time
		var id *uuid.UUID
		if tc.cursor {
			value := time.Date(2020, 1, 1, 1, 0, 0, 0, time.UTC)
			before = &value
			valueID := uuid.New()
			id = &valueID
		}
		t.Logf("status=%s q=%s sort=%s cursor=%t", tc.status, tc.q, tc.sort, tc.cursor)
		args := []any{tc.status, before, id, 26, tc.q, accountID}
		if adminViewSort(tc.sort) {
			var beforeCount *int64
			if tc.cursor {
				value := int64(42)
				beforeCount = &value
			}
			args = append(args, beforeCount)
		}
		rows, err := pool.Query(ctx, "EXPLAIN (ANALYZE,BUFFERS) "+adminListSQL(tc.sort), args...)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			t.Log(line)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
	}
}
