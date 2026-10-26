-- The application must be stopped before this ownership boundary changes.
DO $$
BEGIN
    IF (SELECT count(*) FROM accounts) > 1 THEN
        RAISE EXCEPTION 'legacy ownership is ambiguous: more than one account exists';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM accounts) AND EXISTS (SELECT 1 FROM shares) THEN
        RAISE EXCEPTION 'complete owner setup with the previous release before upgrading';
    END IF;
END $$;

ALTER TABLE accounts ADD COLUMN display_name text NOT NULL DEFAULT 'Owner'
    CHECK (octet_length(display_name) BETWEEN 1 AND 200
           AND display_name = btrim(display_name)
           AND display_name !~ E'[\\r\\n]');

ALTER TABLE shares ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT;
UPDATE shares SET account_id = (SELECT id FROM accounts);
ALTER TABLE shares ALTER COLUMN account_id SET NOT NULL;
CREATE INDEX shares_account_created_at_id_idx ON shares (account_id, created_at DESC, id DESC);

-- A sequence orders registrations and ceremonies without trusting wall time.
CREATE SEQUENCE auth_event_order AS bigint CACHE 1 NO CYCLE;
ALTER TABLE passkey_credentials ADD COLUMN registered_order bigint NOT NULL
    DEFAULT nextval('auth_event_order') CHECK (registered_order > 0);

-- Pending ceremonies use the previous binding rules and must restart.
DELETE FROM auth_flows;
ALTER TABLE auth_flows ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE auth_flows ALTER COLUMN generation DROP NOT NULL;
ALTER TABLE auth_flows ADD COLUMN started_order bigint NOT NULL
    DEFAULT nextval('auth_event_order') CHECK (started_order > 0);
ALTER TABLE auth_flows ADD COLUMN display_name text NOT NULL DEFAULT 'Owner'
    CHECK (octet_length(display_name) BETWEEN 1 AND 200);
ALTER TABLE auth_flows DROP CONSTRAINT auth_flows_kind_check;
ALTER TABLE auth_flows ADD CONSTRAINT auth_flows_kind_check
    CHECK (kind IN ('setup', 'invite', 'login', 'recover', 'verify', 'passkey'));
ALTER TABLE auth_flows ADD CONSTRAINT auth_flows_account_binding_check CHECK (
    (kind = 'login' AND account_id IS NULL AND generation IS NULL) OR
    (kind <> 'login' AND account_id IS NOT NULL AND generation IS NOT NULL AND generation > 0)
);

ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_kind_check;
ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_check;
ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_kind_check
    CHECK (kind IN ('setup', 'invite', 'recover'));
ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_check CHECK (
    (kind IN ('setup', 'invite') AND account_id IS NULL AND generation IS NULL) OR
    (kind = 'recover' AND account_id IS NOT NULL AND generation IS NOT NULL)
);
