package share

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrInvalidAdminParams = errors.New("invalid share list parameters")

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
	Items      []AdminMetadata `json:"items"`
	NextCursor string          `json:"next_cursor,omitempty"`
}

type AdminListParams struct {
	Status string
	Limit  int
	Cursor string
}

type adminCursor struct {
	Version   int        `json:"v"`
	Status    string     `json:"status"`
	CreatedAt time.Time  `json:"created_at"`
	ID        *uuid.UUID `json:"id"`
}

func ValidAdminStatus(status string) bool {
	switch status {
	case "all", "active", "revoked", "expired", "view_limit_exhausted":
		return true
	}
	return false
}

func decodeAdminCursor(value, status string) (*adminCursor, error) {
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
	if cursor.Version != 1 || cursor.Status != status || cursor.CreatedAt.IsZero() || cursor.ID == nil {
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

// Use the Unicode White_Space set independently of the database locale.
const adminWhitespaceSQL = `E' \t\n\v\f\r\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000'`

// Labels are bounded in PostgreSQL so list results never load full Markdown.
const adminLabelSQL = `left(COALESCE(preview_title,
	(SELECT btrim(line, ` + adminWhitespaceSQL + `)
	 FROM regexp_split_to_table(content, E'\n') WITH ORDINALITY AS lines(line, position)
	 WHERE btrim(line, ` + adminWhitespaceSQL + `) <> '' ORDER BY position LIMIT 1), 'Untitled'), 80)`

const adminColumnsSQL = `id, ` + adminLabelSQL + `, created_at, expires_at, max_views, view_count, revoked_at, ` + adminStatusSQL

func (r *AdminRepository) List(ctx context.Context, p AdminListParams) (AdminPage, error) {
	if p.Status == "" {
		p.Status = "all"
	}
	if p.Limit == 0 {
		p.Limit = 25
	}
	if !ValidAdminStatus(p.Status) || p.Limit < 1 || p.Limit > 100 {
		return AdminPage{}, ErrInvalidAdminParams
	}
	cursor, err := decodeAdminCursor(p.Cursor, p.Status)
	if err != nil {
		return AdminPage{}, err
	}
	var beforeTime *time.Time
	var beforeID *uuid.UUID
	if cursor != nil {
		beforeTime, beforeID = &cursor.CreatedAt, cursor.ID
	}
	rows, err := r.tx.Query(ctx, `SELECT `+adminColumnsSQL+` FROM shares
		WHERE ($1 = 'all' OR (`+adminStatusSQL+`) = $1)
		AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
		ORDER BY created_at DESC, id DESC LIMIT $4`, p.Status, beforeTime, beforeID, p.Limit+1)
	if err != nil {
		return AdminPage{}, fmt.Errorf("list shares: %w", err)
	}
	defer rows.Close()
	page := AdminPage{Items: []AdminMetadata{}}
	for rows.Next() {
		var item AdminMetadata
		if err := scanAdmin(rows, &item); err != nil {
			return AdminPage{}, fmt.Errorf("scan share metadata: %w", err)
		}
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return AdminPage{}, fmt.Errorf("list shares: %w", err)
	}
	if len(page.Items) > p.Limit {
		page.Items = page.Items[:p.Limit]
		last := page.Items[len(page.Items)-1]
		b, err := json.Marshal(adminCursor{Version: 1, Status: p.Status, CreatedAt: last.CreatedAt, ID: &last.ID})
		if err != nil {
			return AdminPage{}, err
		}
		page.NextCursor = base64.RawURLEncoding.EncodeToString(b)
	}
	return page, nil
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
	return detail, nil
}

func (r *AdminRepository) Revoke(ctx context.Context, id uuid.UUID) (bool, error) {
	return revoke(ctx, r.tx, id)
}
