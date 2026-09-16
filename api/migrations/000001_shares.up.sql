CREATE TABLE shares (
    id uuid PRIMARY KEY,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    max_views bigint CHECK (max_views IS NULL OR max_views > 0),
    view_count bigint NOT NULL DEFAULT 0 CHECK (view_count >= 0),
    revoked_at timestamptz,
    CHECK (max_views IS NULL OR view_count <= max_views)
);
