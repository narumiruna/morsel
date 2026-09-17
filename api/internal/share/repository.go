package share

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrTokenCollision     = errors.New("token hash collision")
	ErrNotFound           = errors.New("share not found")
	ErrExpired            = errors.New("share expired")
	ErrRevoked            = errors.New("share revoked")
	ErrViewLimitExhausted = errors.New("share view limit exhausted")
)

type Share struct {
	ID             uuid.UUID
	Content        string
	CreatedAt      time.Time
	ExpiresAt      *time.Time
	MaxViews       *int64
	ViewCount      int64
	ViewsRemaining *int64
	RevokedAt      *time.Time
	PreviewEnabled bool
}

type CreateParams struct {
	ID             uuid.UUID
	TokenHash      [32]byte
	Content        string
	ExpiresIn      *int64
	MaxViews       *int64
	PreviewEnabled bool
}

type Repository interface {
	Create(context.Context, CreateParams) (Share, error)
	Consume(context.Context, [32]byte) (Share, error)
	Preview(context.Context, [32]byte) (Share, error)
	Revoke(context.Context, uuid.UUID) (bool, error)
	Ping(context.Context) error
}

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

func (r *PostgresRepository) Ping(ctx context.Context) error {
	return r.pool.Ping(ctx)
}

func (r *PostgresRepository) Create(ctx context.Context, p CreateParams) (Share, error) {
	const query = `
		INSERT INTO shares (id, token_hash, content, expires_at, max_views, preview_enabled)
		VALUES ($1, $2, $3,
			CASE WHEN $4::bigint IS NULL THEN NULL ELSE statement_timestamp() + make_interval(secs => $4::double precision) END,
			$5, $6)
		RETURNING id, content, created_at, expires_at, max_views, view_count, revoked_at, preview_enabled`
	var result Share
	err := r.pool.QueryRow(ctx, query, p.ID, p.TokenHash[:], p.Content, p.ExpiresIn, p.MaxViews, p.PreviewEnabled).Scan(
		&result.ID, &result.Content, &result.CreatedAt, &result.ExpiresAt, &result.MaxViews,
		&result.ViewCount, &result.RevokedAt, &result.PreviewEnabled,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "shares_token_hash_key" {
			return Share{}, ErrTokenCollision
		}
		return Share{}, fmt.Errorf("insert share: %w", err)
	}
	return result, nil
}

func (r *PostgresRepository) Consume(ctx context.Context, tokenHash [32]byte) (Share, error) {
	const query = `
		UPDATE shares
		SET view_count = view_count + 1
		WHERE token_hash = $1
		  AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > statement_timestamp())
		  AND (max_views IS NULL OR view_count < max_views)
		RETURNING id, content, created_at, expires_at, max_views, view_count,
			CASE WHEN max_views IS NULL THEN NULL ELSE max_views - view_count END, revoked_at, preview_enabled`
	var result Share
	err := r.pool.QueryRow(ctx, query, tokenHash[:]).Scan(
		&result.ID, &result.Content, &result.CreatedAt, &result.ExpiresAt, &result.MaxViews,
		&result.ViewCount, &result.ViewsRemaining, &result.RevokedAt, &result.PreviewEnabled,
	)
	if err == nil {
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Share{}, fmt.Errorf("consume share: %w", err)
	}
	return Share{}, r.diagnose(ctx, tokenHash)
}

func (r *PostgresRepository) Preview(ctx context.Context, tokenHash [32]byte) (Share, error) {
	const query = `
		SELECT id, content
		FROM shares
		WHERE token_hash = $1
		  AND preview_enabled
		  AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > statement_timestamp())
		  AND (max_views IS NULL OR view_count < max_views)`
	var result Share
	if err := r.pool.QueryRow(ctx, query, tokenHash[:]).Scan(&result.ID, &result.Content); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Share{}, ErrNotFound
		}
		return Share{}, fmt.Errorf("preview share: %w", err)
	}
	result.PreviewEnabled = true
	return result, nil
}

func (r *PostgresRepository) diagnose(ctx context.Context, tokenHash [32]byte) error {
	const query = `SELECT revoked_at IS NOT NULL,
		(expires_at IS NOT NULL AND expires_at <= statement_timestamp()),
		(max_views IS NOT NULL AND view_count >= max_views)
		FROM shares WHERE token_hash = $1`
	var revoked, expired, exhausted bool
	if err := r.pool.QueryRow(ctx, query, tokenHash[:]).Scan(&revoked, &expired, &exhausted); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("diagnose unavailable share: %w", err)
	}
	switch {
	case revoked:
		return ErrRevoked
	case expired:
		return ErrExpired
	case exhausted:
		return ErrViewLimitExhausted
	default:
		return errors.New("share became unavailable")
	}
}

func (r *PostgresRepository) Revoke(ctx context.Context, id uuid.UUID) (bool, error) {
	const query = `UPDATE shares SET revoked_at = COALESCE(revoked_at, statement_timestamp())
		WHERE id = $1 RETURNING revoked_at`
	var revokedAt time.Time
	if err := r.pool.QueryRow(ctx, query, id).Scan(&revokedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("revoke share: %w", err)
	}
	return true, nil
}
