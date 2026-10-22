package share

import (
	"strings"
	"testing"
	"time"

	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestBackfillDiscovery(t *testing.T) {
	pool := testdb.Open(t)
	ctx := t.Context()
	source := "# **Legacy** [界](https://example.com)\n\n" + strings.Repeat("ordinary paragraph with [link](https://example.com).\n\n", 1200)
	if _, err := pool.Exec(ctx, `INSERT INTO shares(id,token_hash,content)
  SELECT md5(n::text)::uuid,sha256(convert_to(n::text,'UTF8')),$1 FROM generate_series(1,256) n`, source); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	var total int
	var maximum time.Duration
	for {
		batchStart := time.Now()
		n, err := BackfillLabels(ctx, pool, 16)
		duration := time.Since(batchStart)
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
		total += n
		maximum = max(maximum, duration)
	}
	if total != 256 {
		t.Fatalf("backfilled %d", total)
	}
	t.Logf("Backfill: 256 x %d-byte legacy sources, batch16, total=%s maxBatch=%s", len(source), time.Since(start), maximum)
	// Confirm the readiness check remains cheap immediately after backfill,
	// before vacuum removes the now-dead pending-index entries.
	rows, err := pool.Query(ctx, `EXPLAIN (ANALYZE,BUFFERS) SELECT EXISTS(SELECT 1 FROM shares WHERE admin_label IS NULL)`)
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
	largeSource := source + strings.Repeat("ordinary paragraph.\n\n", 50000)
	start = time.Now()
	if label := NormalizeLabel(largeSource, nil); label != "Legacy 界" {
		t.Fatal(label)
	}
	t.Logf("One large source: %d bytes parsed in %s", len(largeSource), time.Since(start))
}
