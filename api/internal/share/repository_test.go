package share

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/testdb"
)

func TestPostgresRepositoryLifecycle(t *testing.T) {
	pool := testdb.Open(t)
	repository := NewPostgresRepository(pool)
	ctx := context.Background()
	token, tokenHash, err := (TokenGenerator{}).Generate()
	if err != nil || token == "" {
		t.Fatal("generate token")
	}
	expiresIn := int64(60)
	maxViews := int64(2)
	before := time.Now()
	created, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), TokenHash: tokenHash, Content: "hello", ExpiresIn: &expiresIn, MaxViews: &maxViews,
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.CreatedAt.Before(before.Add(-time.Second)) || created.ExpiresAt == nil || created.ExpiresAt.Sub(created.CreatedAt) < 59*time.Second {
		t.Fatalf("timestamps were not derived by PostgreSQL: %+v", created)
	}
	first, err := repository.Consume(ctx, tokenHash)
	if err != nil || first.ViewCount != 1 || first.ViewsRemaining == nil || *first.ViewsRemaining != 1 {
		t.Fatalf("first consume = %+v, %v", first, err)
	}
	second, err := repository.Consume(ctx, tokenHash)
	if err != nil || second.ViewCount != 2 || second.ViewsRemaining == nil || *second.ViewsRemaining != 0 {
		t.Fatalf("second consume = %+v, %v", second, err)
	}
	if _, err := repository.Consume(ctx, tokenHash); !errors.Is(err, ErrViewLimitExhausted) {
		t.Fatalf("expected exhausted, got %v", err)
	}
	found, err := repository.Revoke(ctx, created.ID)
	if err != nil || !found {
		t.Fatalf("revoke: found=%v err=%v", found, err)
	}
	var firstRevokedAt time.Time
	if err := pool.QueryRow(ctx, "SELECT revoked_at FROM shares WHERE id=$1", created.ID).Scan(&firstRevokedAt); err != nil {
		t.Fatal(err)
	}
	found, err = repository.Revoke(ctx, created.ID)
	if err != nil || !found {
		t.Fatalf("repeat revoke: found=%v err=%v", found, err)
	}
	var secondRevokedAt time.Time
	if err := pool.QueryRow(ctx, "SELECT revoked_at FROM shares WHERE id=$1", created.ID).Scan(&secondRevokedAt); err != nil {
		t.Fatal(err)
	}
	if !firstRevokedAt.Equal(secondRevokedAt) {
		t.Fatal("idempotent revoke changed timestamp")
	}
	if found, err := repository.Revoke(ctx, uuid.New()); err != nil || found {
		t.Fatalf("unknown revoke: found=%v err=%v", found, err)
	}
}

func TestPostgresRepositoryUnavailableStates(t *testing.T) {
	pool := testdb.Open(t)
	repository := NewPostgresRepository(pool)
	ctx := context.Background()

	_, unknownHash, _ := (TokenGenerator{}).Generate()
	if _, err := repository.Consume(ctx, unknownHash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown token: %v", err)
	}

	for _, test := range []struct {
		name   string
		mutate string
		want   error
	}{
		{name: "expired", mutate: "UPDATE shares SET expires_at=now()-interval '1 second' WHERE id=$1", want: ErrExpired},
		{name: "revoked", mutate: "UPDATE shares SET revoked_at=now() WHERE id=$1", want: ErrRevoked},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, hash, _ := (TokenGenerator{}).Generate()
			created, err := repository.Create(ctx, CreateParams{ID: uuid.New(), TokenHash: hash, Content: test.name})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, test.mutate, created.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := repository.Consume(ctx, hash); !errors.Is(err, test.want) {
				t.Fatalf("want %v, got %v", test.want, err)
			}
		})
	}
}

func TestPostgresRepositoryUnlimitedViews(t *testing.T) {
	pool := testdb.Open(t)
	repository := NewPostgresRepository(pool)
	_, hash, _ := (TokenGenerator{}).Generate()
	if _, err := repository.Create(context.Background(), CreateParams{ID: uuid.New(), TokenHash: hash, Content: "unlimited"}); err != nil {
		t.Fatal(err)
	}
	for i := int64(1); i <= 3; i++ {
		result, err := repository.Consume(context.Background(), hash)
		if err != nil || result.ViewCount != i || result.ViewsRemaining != nil {
			t.Fatalf("consume %d: %+v %v", i, result, err)
		}
	}
}

func TestPostgresRepositorySingleView(t *testing.T) {
	pool := testdb.Open(t)
	repository := NewPostgresRepository(pool)
	_, hash, _ := (TokenGenerator{}).Generate()
	maxViews := int64(1)
	if _, err := repository.Create(context.Background(), CreateParams{
		ID: uuid.New(), TokenHash: hash, Content: "one view", MaxViews: &maxViews,
	}); err != nil {
		t.Fatal(err)
	}
	if result, err := repository.Consume(context.Background(), hash); err != nil || result.ViewCount != 1 {
		t.Fatalf("final view: result=%+v err=%v", result, err)
	}
	if _, err := repository.Consume(context.Background(), hash); !errors.Is(err, ErrViewLimitExhausted) {
		t.Fatalf("expected exhausted after one view, got %v", err)
	}
}

func TestPostgresRepositoryConcurrentFinalViews(t *testing.T) {
	pool := testdb.Open(t)
	repository := NewPostgresRepository(pool)
	_, hash, _ := (TokenGenerator{}).Generate()
	maxViews := int64(5)
	created, err := repository.Create(context.Background(), CreateParams{
		ID: uuid.New(), TokenHash: hash, Content: "race", MaxViews: &maxViews,
	})
	if err != nil {
		t.Fatal(err)
	}
	var successes atomic.Int64
	var unexpected atomic.Int64
	start := make(chan struct{})
	var wait sync.WaitGroup
	for range 25 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			if _, err := repository.Consume(context.Background(), hash); err == nil {
				successes.Add(1)
			} else if !errors.Is(err, ErrViewLimitExhausted) {
				unexpected.Add(1)
			}
		}()
	}
	close(start)
	wait.Wait()
	if successes.Load() != maxViews || unexpected.Load() != 0 {
		t.Fatalf("successes=%d unexpected=%d", successes.Load(), unexpected.Load())
	}
	if got := testdb.Count(t, pool, "SELECT view_count FROM shares WHERE id=$1", created.ID); got != maxViews {
		t.Fatalf("persisted view_count=%d", got)
	}
}

func TestPostgresRepositoryConstraintsAndCollision(t *testing.T) {
	pool := testdb.Open(t)
	repository := NewPostgresRepository(pool)
	ctx := context.Background()
	_, hash, _ := (TokenGenerator{}).Generate()
	if _, err := repository.Create(ctx, CreateParams{ID: uuid.New(), TokenHash: hash, Content: "one"}); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Create(ctx, CreateParams{ID: uuid.New(), TokenHash: hash, Content: "two"}); !errors.Is(err, ErrTokenCollision) {
		t.Fatalf("expected collision, got %v", err)
	}
	zero := int64(0)
	_, newHash, _ := (TokenGenerator{}).Generate()
	if _, err := repository.Create(ctx, CreateParams{ID: uuid.New(), TokenHash: newHash, Content: "bad", MaxViews: &zero}); err == nil {
		t.Fatal("expected database constraint failure")
	}
}
