package share

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BackfillLabels processes and commits at most batchSize rows. Each document is read and
// parsed separately, outside account/session locks. NULL is the durable work
// queue: interruption and repeated calls do not change completed labels.
// Shares are immutable; the conditional update also makes concurrent workers
// safe. The result is the number of selected rows processed (including rows
// completed concurrently). Zero means no pending rows at the selection snapshot.
// A cancelled database operation can have committed before cancellation; retry
// is safe because completed labels are never changed.
func BackfillLabels(ctx context.Context, pool *pgxpool.Pool, batchSize int) (int, error) {
	if batchSize < 1 || batchSize > 100 {
		return 0, fmt.Errorf("label batch size must be between 1 and 100")
	}
	rows, err := pool.Query(ctx, "SELECT id FROM shares WHERE admin_label IS NULL ORDER BY id LIMIT $1", batchSize)
	if err != nil {
		return 0, fmt.Errorf("read pending labels: %w", err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	completed := 0
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return completed, err
		}
		var content string
		var title *string
		if err := pool.QueryRow(ctx, "SELECT content, preview_title FROM shares WHERE id=$1", id).Scan(&content, &title); err != nil {
			return completed, fmt.Errorf("read label source: %w", err)
		}
		label := NormalizeLabel(content, title)
		_, err := pool.Exec(ctx, "UPDATE shares SET admin_label=$2 WHERE id=$1 AND admin_label IS NULL", id, label)
		if err != nil {
			return completed, fmt.Errorf("store label: %w", err)
		}
		completed++
	}
	return completed, nil
}
