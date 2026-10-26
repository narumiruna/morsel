CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    auth_generation bigint NOT NULL DEFAULT 1 CHECK (auth_generation > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE passkey_credentials (
    id text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name text NOT NULL,
    credential jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX passkey_credentials_account ON passkey_credentials(account_id);
CREATE TABLE auth_grants (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    kind text NOT NULL CHECK (kind IN ('setup', 'recover')),
    account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
    generation bigint,
    expires_at timestamptz NOT NULL,
    CHECK ((kind = 'setup' AND account_id IS NULL AND generation IS NULL) OR
           (kind = 'recover' AND account_id IS NOT NULL AND generation IS NOT NULL))
);
CREATE INDEX auth_grants_expiry ON auth_grants(expires_at);
CREATE TABLE auth_sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    generation bigint NOT NULL,
    csrf_token text NOT NULL,
    verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id);
CREATE TABLE auth_flows (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    kind text NOT NULL CHECK (kind IN ('setup', 'login', 'recover', 'verify', 'passkey')),
    account_id uuid NOT NULL,
    generation bigint NOT NULL,
    session_hash bytea,
    grant_hash bytea,
    name text NOT NULL,
    session_data jsonb NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX auth_flows_expiry ON auth_flows(expires_at);
CREATE INDEX auth_flows_account ON auth_flows(account_id);
CREATE TABLE api_keys (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name text NOT NULL,
    prefix text NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz
);
CREATE INDEX api_keys_account ON api_keys(account_id);
