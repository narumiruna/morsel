-- Never remove account isolation while multiple accounts exist.
DO $$
BEGIN
    IF (SELECT count(*) FROM accounts) > 1 THEN
        RAISE EXCEPTION 'cannot remove account isolation while multiple accounts exist';
    END IF;
END $$;

DELETE FROM auth_flows;
DELETE FROM auth_grants WHERE kind = 'invite';
ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_check;
ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_kind_check;
ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_kind_check CHECK (kind IN ('setup', 'recover'));
ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_check CHECK (
    (kind = 'setup' AND account_id IS NULL AND generation IS NULL) OR
    (kind = 'recover' AND account_id IS NOT NULL AND generation IS NOT NULL)
);
ALTER TABLE auth_flows DROP CONSTRAINT auth_flows_account_binding_check;
ALTER TABLE auth_flows DROP CONSTRAINT auth_flows_kind_check;
ALTER TABLE auth_flows ADD CONSTRAINT auth_flows_kind_check
    CHECK (kind IN ('setup', 'login', 'recover', 'verify', 'passkey'));
ALTER TABLE auth_flows ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE auth_flows ALTER COLUMN generation SET NOT NULL;
ALTER TABLE auth_flows DROP COLUMN display_name;
ALTER TABLE auth_flows DROP COLUMN started_order;
ALTER TABLE passkey_credentials DROP COLUMN registered_order;
DROP SEQUENCE auth_event_order;
DROP INDEX shares_account_created_at_id_idx;
ALTER TABLE shares DROP COLUMN account_id;
ALTER TABLE accounts DROP COLUMN display_name;
