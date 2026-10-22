package share

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrInvalidAdminParams = errors.New("invalid share list parameters")
var ErrLabelBackfillRequired = errors.New("share label backfill required")

// AdminMetadata contains no capability data or full content.
type AdminMetadata struct {
	ID        uuid.UUID  `json:"id"`
	Label     string     `json:"label"`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt *time.Time `json:"expires_at"`
	MaxViews  *int64     `json:"max_views"`
	ViewCount int64      `json:"view_count"`
	RevokedAt *time.Time `json:"revoked_at"`
	Status    string     `json:"status"`
}

type AdminDetail struct {
	AdminMetadata
	Content string `json:"content"`
}

type AdminPage struct {
	Items         []AdminMetadata `json:"items"`
	NextCursor    string          `json:"next_cursor,omitempty"`
	MatchingCount int64           `json:"matching_count"`
}

type AdminListParams struct {
	Status string
	Limit  int
	Cursor string
	Q      string
	Sort   string
}

type adminCursor struct {
	Version    int        `json:"v"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"created_at"`
	ID         *uuid.UUID `json:"id"`
	Sort       string     `json:"sort,omitempty"`
	SearchHash string     `json:"search_hash,omitempty"`
}

func ValidAdminStatus(status string) bool {
	switch status {
	case "all", "active", "revoked", "expired", "view_limit_exhausted":
		return true
	}
	return false
}

func decodeAdminCursor(value string, p AdminListParams) (*adminCursor, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > 512 {
		return nil, ErrInvalidAdminParams
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil {
		return nil, ErrInvalidAdminParams
	}
	var cursor adminCursor
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cursor); err != nil {
		return nil, ErrInvalidAdminParams
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidAdminParams
	}
	if cursor.Status != p.Status || cursor.CreatedAt.IsZero() || cursor.ID == nil {
		return nil, ErrInvalidAdminParams
	}
	switch cursor.Version {
	case 1:
		if p.Q != "" || p.Sort != "newest" || cursor.Sort != "" || cursor.SearchHash != "" {
			return nil, ErrInvalidAdminParams
		}
	case 2:
		if cursor.Sort != p.Sort || cursor.SearchHash != searchHash(p.Q) {
			return nil, ErrInvalidAdminParams
		}
	default:
		return nil, ErrInvalidAdminParams
	}
	return &cursor, nil
}

// AdminRepository uses the caller's authorization transaction. The caller must
// hold the account and session locks until this transaction commits.
type AdminRepository struct {
	tx pgx.Tx
}

func NewAdminRepository(tx pgx.Tx) *AdminRepository { return &AdminRepository{tx: tx} }

// Status uses database time and the same precedence as public diagnostics.
const adminStatusSQL = `CASE
	WHEN revoked_at IS NOT NULL THEN 'revoked'
	WHEN expires_at IS NOT NULL AND expires_at <= statement_timestamp() THEN 'expired'
	WHEN max_views IS NOT NULL AND view_count >= max_views THEN 'view_limit_exhausted'
	ELSE 'active' END`

const adminColumnsSQL = `id, COALESCE(admin_label, '') AS label, created_at, expires_at, max_views, view_count, revoked_at, ` + adminStatusSQL + ` AS status`

func searchHash(q string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(q)))
}

func NormalizeAdminQuery(p AdminListParams) (AdminListParams, error) {
	if p.Status == "" {
		p.Status = "all"
	}
	if p.Sort == "" {
		p.Sort = "newest"
	}
	if p.Limit == 0 {
		p.Limit = 25
	}
	p.Q = strings.TrimSpace(p.Q)
	if !ValidAdminStatus(p.Status) || (p.Sort != "newest" && p.Sort != "oldest") || p.Limit < 1 || p.Limit > 100 || !utf8.ValidString(p.Q) || utf8.RuneCountInString(p.Q) > 100 {
		return p, ErrInvalidAdminParams
	}
	return p, nil
}

func (r *AdminRepository) List(ctx context.Context, p AdminListParams) (AdminPage, error) {
	var err error
	p, err = NormalizeAdminQuery(p)
	if err != nil {
		return AdminPage{}, err
	}
	cursor, err := decodeAdminCursor(p.Cursor, p)
	if err != nil {
		return AdminPage{}, err
	}
	var beforeTime *time.Time
	var beforeID *uuid.UUID
	if cursor != nil {
		beforeTime, beforeID = &cursor.CreatedAt, cursor.ID
	}
	// PostgreSQL text cannot contain NUL, so such a literal query cannot
	// match any label. A NULL search value gives that result without sending
	// an invalid text parameter; the pending-label check still applies.
	var search any = p.Q
	if strings.ContainsRune(p.Q, '\x00') {
		search = nil
	}
	rows, err := r.tx.Query(ctx, adminListSQL(p.Sort), p.Status, beforeTime, beforeID, p.Limit+1, search)
	if err != nil {
		return AdminPage{}, fmt.Errorf("list shares: %w", err)
	}
	defer rows.Close()
	page := AdminPage{Items: []AdminMetadata{}}
	for rows.Next() {
		var item AdminMetadata
		var pending bool
		if err := rows.Scan(&page.MatchingCount, &pending, &item.ID, &item.Label, &item.CreatedAt, &item.ExpiresAt, &item.MaxViews, &item.ViewCount, &item.RevokedAt, &item.Status); err != nil {
			return AdminPage{}, fmt.Errorf("scan share metadata: %w", err)
		}
		if pending {
			return AdminPage{}, ErrLabelBackfillRequired
		}
		if item.Label != "" {
			page.Items = append(page.Items, item)
		}
	}
	if err := rows.Err(); err != nil {
		return AdminPage{}, fmt.Errorf("list shares: %w", err)
	}
	if len(page.Items) > p.Limit {
		page.Items = page.Items[:p.Limit]
		last := page.Items[len(page.Items)-1]
		b, err := json.Marshal(adminCursor{Version: 2, Status: p.Status, CreatedAt: last.CreatedAt, ID: &last.ID, Sort: p.Sort, SearchHash: searchHash(p.Q)})
		if err != nil {
			return AdminPage{}, err
		}
		page.NextCursor = base64.RawURLEncoding.EncodeToString(b)
	}
	return page, nil
}

// One statement supplies count and page from the same snapshot and database
// time. strpos has no SQL wildcard/escape syntax. The pending-label check
// prevents incomplete legacy results, including for zero-match queries.
func adminListSQL(sort string) string {
	direction, comparison := "DESC", "<"
	if sort == "oldest" {
		direction, comparison = "ASC", ">"
	}
	return `WITH matching AS NOT MATERIALIZED (
  SELECT ` + adminColumnsSQL + ` FROM shares
  WHERE ($1 = 'all' OR (` + adminStatusSQL + `) = $1)
  AND strpos(lower(admin_label), lower($5)) > 0
 ), totals AS (
  SELECT count(*) AS matching_count,
   EXISTS(SELECT 1 FROM shares WHERE admin_label IS NULL) AS pending FROM matching
 ) SELECT totals.matching_count, totals.pending,
  COALESCE(page.id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(page.label, ''), COALESCE(page.created_at, statement_timestamp()),
  page.expires_at, page.max_views, COALESCE(page.view_count,0), page.revoked_at, COALESCE(page.status,'')
 FROM totals LEFT JOIN LATERAL (
  SELECT * FROM matching WHERE ($2::timestamptz IS NULL OR (created_at,id) ` + comparison + ` ($2,$3::uuid))
  ORDER BY created_at ` + direction + `, id ` + direction + ` LIMIT $4
 ) page ON true`
}

func scanAdmin(row pgx.Row, item *AdminMetadata, extra ...any) error {
	args := []any{&item.ID, &item.Label, &item.CreatedAt, &item.ExpiresAt, &item.MaxViews, &item.ViewCount, &item.RevokedAt, &item.Status}
	return row.Scan(append(args, extra...)...)
}

func (r *AdminRepository) Detail(ctx context.Context, id uuid.UUID) (AdminDetail, error) {
	var detail AdminDetail
	err := scanAdmin(r.tx.QueryRow(ctx, `SELECT `+adminColumnsSQL+`, content FROM shares WHERE id = $1`, id), &detail.AdminMetadata, &detail.Content)
	if errors.Is(err, pgx.ErrNoRows) {
		return AdminDetail{}, ErrNotFound
	}
	if err != nil {
		return AdminDetail{}, fmt.Errorf("get share detail: %w", err)
	}
	if detail.Label == "" {
		return AdminDetail{}, ErrLabelBackfillRequired
	}
	return detail, nil
}

func (r *AdminRepository) Revoke(ctx context.Context, id uuid.UUID) (bool, error) {
	return revoke(ctx, r.tx, id)
}
