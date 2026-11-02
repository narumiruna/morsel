CREATE TABLE oauth_clients (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 200),
    redirect_uris jsonb NOT NULL CHECK (jsonb_typeof(redirect_uris)='array' AND jsonb_array_length(redirect_uris) BETWEEN 1 AND 5),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_clients_expiry ON oauth_clients(expires_at);

CREATE TABLE oauth_requests (
    handle_hash bytea PRIMARY KEY CHECK (octet_length(handle_hash)=32),
    client_id uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    form jsonb NOT NULL CHECK (jsonb_typeof(form)='object' AND octet_length(form::text)<=16384),
    account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
    generation bigint,
    session_hash bytea,
    expires_at timestamptz NOT NULL,
    CHECK ((account_id IS NULL AND generation IS NULL AND session_hash IS NULL) OR
           (account_id IS NOT NULL AND generation IS NOT NULL AND session_hash IS NOT NULL AND octet_length(session_hash)=32))
);
CREATE INDEX oauth_requests_expiry ON oauth_requests(expires_at);

CREATE TABLE oauth_grants (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    generation bigint NOT NULL,
    client_id uuid NOT NULL REFERENCES oauth_clients(id),
    issuer text NOT NULL,
    resource text NOT NULL,
    scope text NOT NULL CHECK (scope IN ('mcp:shares','mcp:shares offline_access')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at>created_at)
);
CREATE INDEX oauth_grants_owner ON oauth_grants(account_id,created_at DESC,id);
CREATE INDEX oauth_grants_expiry ON oauth_grants(expires_at);

CREATE TABLE oauth_tokens (
    signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
    kind text NOT NULL CHECK (kind IN ('code','access','refresh','pkce')),
    grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    active boolean NOT NULL DEFAULT true,
    request_data jsonb NOT NULL CHECK (jsonb_typeof(request_data)='object' AND octet_length(request_data::text)<=16384),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY(signature,kind)
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens(expires_at);
