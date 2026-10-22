package share

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestAdminQueryDiscovery(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content,admin_label,created_at,revoked_at)
  SELECT md5(n::text)::uuid,sha256(convert_to(n::text,'UTF8')),
  '# **Résumé** [界](https://example.com)'||repeat(E'\nparagraph [link](https://example.com).',1600),
  'Résumé 界 code '||n,'2020-01-01Z'::timestamptz+n*interval '1 second',
  CASE WHEN n%5=0 THEN now() ELSE NULL END FROM generate_series(1,10000) n;
  ANALYZE shares`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		status, q, sort string
		cursor          bool
	}{
		{"all", "RÉSUMÉ", "newest", false}, {"active", "界", "oldest", false}, {"revoked", "absent", "newest", false}, {"all", "RÉSUMÉ", "oldest", true},
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
		rows, err := pool.Query(ctx, "EXPLAIN (ANALYZE,BUFFERS) "+adminListSQL(tc.sort), tc.status, before, id, 26, tc.q)
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
