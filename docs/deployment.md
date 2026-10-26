# Deployment and configuration

For local deployment, use the [Quick start](../README.md#quick-start). Build the image explicitly with `docker build --tag "$MORSEL_IMAGE" .`; [`compose.yaml`](../compose.yaml) has no build definition. For a fresh database, Compose starts PostgreSQL, applies migrations, and starts Morsel as a non-root user on loopback. Existing deployments must use the [maintenance upgrade](#multi-account-maintenance-upgrade), not plain `docker compose up`. Keep the PostgreSQL password URL-safe because Compose uses it in a connection URL. `.env` is ignored by Git; [`.env.example`](../.env.example) contains no secrets.

## Configuration

The API reads these environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MORSEL_DATABASE_URL` | yes | — | PostgreSQL connection URL. |
| `MORSEL_URL` | yes | — | Public origin for share links, invitation links, and WebAuthn. Non-root paths, queries, fragments, and credentials are rejected. |
| `MORSEL_VIEWER_DIR` | no | `../viewer/dist` | Viewer directory, relative to the usual `packages/server/` working directory. The container uses `/srv/viewer`. |
| `MORSEL_ENVIRONMENT` | no | `development` | Set to `production` to require HTTPS. |
| `MORSEL_ADDRESS` | no | `:12647` | API listen address. |
| `MORSEL_MAX_DOCUMENT_BYTES` | no | `1048576` | UTF-8 Markdown byte limit. |
| `MORSEL_MAX_REQUEST_BYTES` | no | `1114112` | Whole request-body limit; must exceed the document limit. |
| `MORSEL_READ_HEADER_TIMEOUT` | no | `5s` | HTTP header timeout. |
| `MORSEL_READ_TIMEOUT` | no | `15s` | HTTP request read timeout. |
| `MORSEL_WRITE_TIMEOUT` | no | `30s` | HTTP response write timeout. |
| `MORSEL_IDLE_TIMEOUT` | no | `60s` | Keep-alive idle timeout. |
| `MORSEL_REQUEST_TIMEOUT` | no | `20s` | Per-request context deadline. |
| `MORSEL_SHUTDOWN_TIMEOUT` | no | `10s` | Graceful shutdown deadline. |
| `MORSEL_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error`. |

Startup rejects insecure public URLs, empty viewer paths, and invalid limits or timeouts. Errors do not echo configured secrets. Server API key environment configuration and key-file loading are removed. Clients and scripts can still use `MORSEL_API_KEY` for a key created in the UI; do not pass it to the server.

The WebAuthn RP ID is derived from the hostname in `MORSEL_URL`, without a scheme or port. The allowed origin includes its scheme and port. Production uses `MORSEL_URL=https://morsel.narumi.dev`, RP ID `morsel.narumi.dev`, and origin `https://morsel.narumi.dev`. These values are not derived from request headers. WebAuthn requires a hostname RP ID; numeric IP origins are not supported. Use `localhost`, not `127.0.0.1` or `::1`, for the configured development browser origin. API clients can still connect through loopback IPs. Keep the hostname stable: an RP ID change can require passkey re-enrollment. Development uses [the exact localhost origin](development.md#interactive-account-development).

## Share link storage

Migration 10 adds nullable `link_token` storage. New shares retain their original tokens without encryption. Public reads still use the SHA-256 hash. Only the authenticated owning account can retrieve a stored URL; list and detail responses return only `link_available`. No share-link encryption key is required.

**Database or backup access exposes retained share tokens and Markdown content.** Treat both as secrets. A token grants public read access subject to the share's limits and revocation. Revoke shares whose tokens are exposed.

Historical migration-10 recovery prerequisites still apply:

1. Back up PostgreSQL and test recovery on a restored copy.
2. If the database used the encrypted-storage release, recover its retained tokens with that release and its original key **before the multi-account cutover**, while its single-account data is compatible. Copy recovered tokens to `link_token` in an operator-controlled data migration after applying migration 10; verify each token against its existing `token_hash`. Do not discard the original key or backup until recovery is verified. Never start that old release against multi-account data to recover tokens.
3. Use the maintenance upgrade below for migrations 11 and 12. Deploy the API and viewer together; never mix old and new writers.
4. Confirm that Copy link and Show link survive a page reload without changing view counts.

Legacy rows without a plaintext token show **Link unavailable**. Their original public URLs remain valid subject to existing limits and revocation. Hashes cannot restore original tokens. Migration 10 does not regenerate tokens, change public URLs, or automatically decrypt old data. It preserves migration 9's `link_ciphertext` column for recovery; the new server does not read it.

Historical migration-10 compatibility: older single-account applications used the same public hashes but could not retrieve plaintext-only saved links; the encrypted-storage release also needed its original key. Its runner rejects version 10. On a compatible, isolated single-account database only, a new-runner down step with version 10 confirmed as latest drops `link_token` and permanently removes saved-link retrieval unless restored from backup. Hashes and old ciphertext remain. This is historical guidance, not authorization to run an old unscoped application after the multi-account cutover. The [multi-account rollback restrictions](#backup-restore-and-rollback) always take precedence.

## Operator setup and recovery

The image contains the static `/usr/local/bin/account` executable. It reads only `MORSEL_DATABASE_URL`; it does not require viewer or public-origin configuration. From source, run `cd packages/server` and use `GOTOOLCHAIN=go1.26.10 go run ./cmd/account` with `-kind setup`, `-kind invite`, or `-kind recover -account-id ACCOUNT_UUID`. Each command prints one raw token; only its hash is stored. Treat the output as a secret. Keep setup and recovery tokens out of all URLs. Invitation tokens alone may use the configured-origin `/invite#token=<43-character base64url token>` format; never put any grant secret in a query or path, log, ticket, or shell trace. CLI output remains a raw token; manual form entry remains supported.

For Compose, use the same environment, image, project, and database as the target deployment. Start PostgreSQL and complete migrations first. The image is distroless and has no shell; use the executable directly:

```sh
docker compose run --rm --no-deps --entrypoint /usr/local/bin/account morsel -kind setup
```

1. Open `/setup` at the configured browser origin. For production, use <https://morsel.narumi.dev/setup>. The setup form is available only before account setup is complete.
2. Enter the token in the setup form within one hour and complete passkey registration. The WebAuthn flow expires after 10 minutes; the browser can end its prompt sooner. The token is single-use; setup works only for an empty deployment. Setup explicitly creates an `admin`. The role allows browser invitation issuance, not access to another account's shares.
3. Add a backup passkey. Removal of the last passkey is rejected.
4. Create named API keys and save each raw value in the appropriate client secret store when shown. It is shown only once; only its SHA-256 hash and metadata are stored.

Before setup, health checks and the setup UI work, but privileged share operations are rejected. Existing public capability reads are unchanged.

For each additional account, an admin can use **Invitations** at `/manage/invitations`: select **Create invitation link**, complete fresh verification if requested, and use **Copy link** or the **Invitation link** textbox. Deliver the link manually through a secure messaging channel, then use **Dismiss invitation link**. The server requires an admin browser session, exact Origin, CSRF, and passkey verification within twelve hours; the current database role check and grant insert share one transaction. Admin-owned API keys alone cannot invite. Success returns 201 with a configured-origin fragment URL and database-derived expiry, no-store, and the account marker. Rate limits return 429 with `Retry-After` and insert no grant. Failed or uncertain issuance is not automatically replayed; an explicit retry creates an independent link.

The trusted operator CLI remains available:

```sh
docker compose run --rm --no-deps --entrypoint /usr/local/bin/account morsel -kind invite
```

Deliver the raw token through a secure channel. The recipient opens `/invite`, enters **Invitation token** within one hour, supplies **Account name** and **Passkey name**, and explicitly selects **Create account**. An admin link prefills the same form. Every invitation, including operator invitations, creates a `user`, first passkey, and session atomically. Recipients cannot select a role. Invitations are independent, single-use, and forwardable: anyone holding an unused token can register before expiry. There is no SMTP, email binding, or person verification. No invitation list or revocation is provided; dismissal, issuer logout, and issuer recovery do not invalidate pending links. Existing valid grants remain compatible and retain only hashes, with no new plaintext grant storage.

Opening `/invite` or fetching a preview does not consume the grant. The viewer removes the fragment immediately and keeps its token only in flow memory; explicit registration sends it only in the existing POST body. A signed-in recipient must log out or use a private window, then reopen the original link; there is no silent account switch or persistence across logout. Both invite begin and finish return `409 sign_out_required` for a valid signed-in session without consuming the grant or overwriting that session. Invalid/expired cookies may proceed; database errors fail closed. Cancellation does not consume the grant, but cancellation or reload can require reopening the link. Invalid, expired, used, or concurrently redeemed grants retain the generic invalid-grant response.

Fragment cleanup cannot erase external messaging previews, URL rewriting, retained copies, or browser history copies made before cleanup. Keep invitation links out of logs and tickets. Display names need not be unique and do not authorize requests; the account UUID is the stable WebAuthn user handle. Existing passkeys remain valid. New invited accounts start with no shares. There is no public registration, role editing, invitations that create admins, user directory, or application-level account enumeration.

If all passkeys are lost or compromised, an authorized operator can issue a recovery token:

```sh
docker compose run --rm --no-deps --entrypoint /usr/local/bin/account morsel -kind recover -account-id ACCOUNT_UUID
```

Obtain the UUID from the authenticated `/v1/account` response or the read-only operator query below. Never select a target by display name. The browser resolves recovery from the grant, not an owner argument. Issuing a replacement cancels older recovery grants for that account only.

Enter the single-use token in the recovery form at `/recover` within one hour and enroll a replacement passkey. Recovery completion replaces that account's old credentials, advances its authentication generation, and invalidates its old sessions, bound authentication flows, verification grants, and recovery grants. Other accounts and their unbound login flows are unaffected. Shares keep their owner and the account keeps its role. It does not delete shares or reset the database. **Recovery does not revoke API keys.** Review and revoke suspect keys separately, update affected clients, and enroll a backup passkey again.

Sessions expire 30 days after login, without sliding renewal. Their persistent cookies survive browser restarts; logout and account recovery still revoke sessions immediately. Key creation, key revocation, share revocation, invitation issuance, and passkey changes reuse passkey verification for 12 hours, then require verification again. The UI checks the current server session before each change. Production session cookies remain `Secure`, `HttpOnly`, host-only, and `SameSite=Lax`.

Existing sessions keep their original database expiry and cookie lifetime. After deployment, log out and sign in again to receive a 30-day persistent session. Tokens already issued keep their stored expiry. Longer lifetimes increase the time that a stolen session or unused grant can remain valid. Revoke compromised sessions; a replacement recovery grant cancels earlier recovery grants for that account, but issuing a new invitation never revokes earlier invitations.

Authentication POST requests have a fixed limit of 60 attempts per source address and ceremony kind per minute, plus a service-wide limit of 1000 per minute. Account-state reads and key-management requests do not consume ceremony limits. Forwarded client IP headers are not trusted; clients behind the same proxy share source-address limits. Apply per-client abuse controls at the existing trusted reverse proxy when needed. Login attempts have a separate budget from verification, setup, invitation, and recovery. Browser invitation issuance uses the existing limiter with a fixed issuance bucket and the same request-size protection; it is separate from invitation registration. No new limiter configuration is provided.

### Rotate or revoke client keys

1. Open `/manage/api-keys`. If signed out, sign in at the redirected `/login` page. Complete fresh passkey verification and create a named replacement key.
2. Save its one-time value in the client secret store and update all affected clients. Existing clients and scripts can retain the variable name `MORSEL_API_KEY`.
3. Verify share creation and revocation with the replacement, then revoke the old key in the UI. No server restart is needed.

All active keys belonging to an account have the same permissions on that account's shares. A replacement can revoke shares created by another key in the same account, but cannot manage a foreign share. Foreign and missing share UUIDs return the same `404 not_found`. Key revocation blocks subsequent requests, not an operation already authorized. Revoking a key does not revoke its shares; revoke exposed shares separately.

## Production deployment

HTTPS and reverse-proxy provisioning are already in place and are not changed here. Set `MORSEL_ENVIRONMENT=production` and `MORSEL_URL=https://morsel.narumi.dev`. Keep port 12647 behind the existing HTTPS reverse proxy.

The reverse proxy must:

- Preserve the browser `Origin` header unchanged and preserve `X-Request-ID` and `X-Morsel-Account-ID` response headers. The account marker is server-derived, never a request-side owner selector.
- Never cache `/v1/*` (including authentication and management), `/manage/*`, `/account`, `/account/*`, `/login`, `/recover`, `/setup`, `/invite`, or `/s/*`; honor `Cache-Control: no-store`.
- Exclude authorization headers, cookies, setup/invitation/recovery tokens, WebAuthn payloads, raw keys, request bodies, and raw `/s/<token>` paths from logs. Do not enable shell tracing around secret operations.
- Not replace the configured WebAuthn origin with forwarded request headers. Do not assume arbitrary forwarded client IP headers are trusted.

The Go server sends a Content Security Policy, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. CORS remains disabled. Default hash routing keeps capabilities out of initial document requests. Preview metadata intentionally uses a path capability; the Go logger does not log the raw path.

## Multi-account maintenance upgrade

**No production release or workflow dispatch is authorized by this implementation task.** The **Deploy** workflow uses manual `workflow_dispatch` only; push-to-main deployment is disabled. The **Publish** workflow can create release artifacts automatically; it does not deploy services or apply migrations. Do not deploy intermediate implementation commits. Keep this gate until required checks and the operator prerequisites below pass. Automatic deployment may resume only when every deployment and rollback path preserves account isolation.

Migrations 11 and 12 require a coordinated outage. Stop **all** old instances and all writes, including setup and invitation writers, before running the new migration. An old server can still perform global reads and revocation with the new schema present. Do not use mixed-version or zero-downtime deployment.

### Legacy preflight and ownership

Run these read-only queries on a restored production copy first, and compare with the intended deployment before cutover. They work at schema 10:

```sql
BEGIN READ ONLY;
SELECT version, dirty FROM schema_migrations;
SELECT count(*) AS legacy_accounts FROM accounts;
SELECT count(*) AS legacy_shares FROM shares;
SELECT id, created_at FROM accounts ORDER BY created_at, id;
COMMIT;
```

| Legacy state | Required action |
| --- | --- |
| No accounts and no shares | Upgrade; complete first setup before creating shares. |
| Exactly one account | Upgrade assigns all existing shares to that account. Record the expected count. |
| Shares but no account | Complete operator setup on the current migration-10 release first, then stop it and retry the upgrade. |
| More than one account before migration 11 | Stop. Require an explicit operator-reviewed correction; do not guess ownership from API keys. |

Upgrade preflight checks these unsafe states before the runner writes a dirty marker; a failed data precondition remains retryable. Migration SQL repeats the ownership assertion in its transaction. Migration 11 adds `accounts.display_name` (legacy value `Owner`), `shares.account_id NOT NULL` with restrictive account deletion, and an account-leading history index. It adds the monotonic `auth_event_order` sequence for credential and login-flow ordering; only login flows may be unbound. Do not reset the sequence during recovery.

The cutover clears pending authentication flows. It preserves content, share UUIDs, capability hashes and stored plaintext tokens, preview metadata, labels, timestamps, limits, counts, revocation state, passkeys, sessions, API keys, and existing grants with valid bindings. Existing sessions keep their stored expiry. No key rotation or passkey re-enrollment is required for migration 11. Historical environment-configured keys are not supported; they must already have been replaced with account-issued keys.

### Admin role upgrade (migration 12)

For a schema-11 deployment, migration 12 adds `accounts.role NOT NULL DEFAULT 'user'`, constrained to `admin` and `user`. It promotes exactly the oldest existing account ordered by `created_at, id`. All others become users. No existing accounts means no promotion; first setup must insert admin explicitly. Startup and login do not reassign roles. Recovery preserves the account role. Roles never bypass share ownership.

Before migration, run this read-only schema-11 preflight on a restored production copy first. Verify that `version = 11` and `dirty = false`, then verify and record the selected UUID, not its display name. Compare it with the actual deployment before cutover:

```sql
BEGIN READ ONLY;
SELECT version, dirty FROM schema_migrations;
SELECT id AS selected_admin_account_id, display_name, created_at
FROM accounts ORDER BY created_at, id LIMIT 1;
SELECT id AS account_id, display_name, created_at
FROM accounts ORDER BY created_at, id;
COMMIT;
```

An empty result requires first setup after upgrade, not an inferred promotion. Stop if the selected UUID is not the intended admin; role editing and additional-admin provisioning are outside this phase. Do not substitute a display-name match or add an undocumented promotion endpoint.

Migration 12 preserves shares, ownership, capability hashes/tokens, previews, counts, labels, passkeys, sessions, API keys, existing valid grants, authentication generation, and ordering. It adds no plaintext invitation storage. Stop every old instance before applying it, even on an empty database: an old setup writer omits the role and would create only a user after the empty bootstrap migration. Do not use a mixed-version bootstrap. Keep the existing guarded manual deployment sequence below unchanged; no automatic deployment or workflow dispatch is authorized here.

After migration, verify clean schema 12 and roles before reopening service:

```sql
BEGIN READ ONLY;
SELECT version, dirty FROM schema_migrations;
SELECT id AS account_id, display_name, role, created_at
FROM accounts ORDER BY created_at, id;
SELECT role, count(*) FROM accounts GROUP BY role ORDER BY role;
COMMIT;
```

Compare the admin UUID with the preflight result and verify that all other existing accounts are users. Test admin link issuance, user denial, and enrollment as user with fixture accounts. Verify targeted recovery preserves role and all existing account-isolation/public-capability checks still pass. Production account history, restore behavior, and migration lock duration require operator verification; local fixture timings are not production guarantees.

### Maintenance sequence

1. Confirm required validation has passed. Retain immutable image references and a tested PostgreSQL backup. Rehearse restore, migration, ownership counts, failure handling, and downgrade guards on a restored copy. Backups contain plaintext capabilities; protect them as secrets. Measure production-scale backfill/index lock duration before selecting the window.
2. Resolve legacy ownership on the current release, if needed. The responsible operator must enroll any missing original owner before upgrade. Prepare two account owners and fixture content for smoke tests; never expose real tokens in logs or tickets.
3. Begin the maintenance window. Pause client, browser, and other writers. Stop every old application instance, including replicas outside this Compose project. Confirm no old instance can restart. Do not run the new migration until this is verified.
4. The guarded workflow runs `bash scripts/deploy.sh` with `MORSEL_IMAGE` set to the selected new immutable image. The shared script enforces this sequence:

   ```sh
   docker compose stop morsel
   docker compose up --detach --wait --wait-timeout 120 postgres
   docker compose run --rm --no-deps migrate
   docker compose up --detach --no-deps --wait --wait-timeout 120 morsel
   ```

   PostgreSQL must be healthy before migration. Migration must complete before the combined new API/viewer starts. Dependencies are not restarted during application startup. Any failure must leave the application stopped; never automatically restart the old image or downgrade. A local Compose stop does not replace stopping external replicas in step 3.
5. Before reopening service, run the ownership checks below and compare the original account's count with the recorded legacy count. Verify clean schema 12 and the selected admin UUID and user roles with the role queries above. Verify the new API and viewer together, direct navigation to `/login`, `/setup`, `/invite`, `/recover`, `/account`, `/manage/shares`, `/manage/api-keys`, and admin-only `/manage/invitations`, and unchanged public capability behavior.
6. With operator-supplied real keys, check that two keys in A can manage A's shares, B cannot inspect or revoke A's UUID (uniform 404), and B's list/count/search excludes A. Check saved-link retrieval and verification, key revocation, identity switching, and v1/v2 cursor rejection with page-one reset. A valid public capability still permits reads from either account. Resume writes only after operator verification.

After schema 11, these queries are read-only. The first query enumerates accounts **for operators only**; the application has no enumeration route. Display names are not unique selectors:

```sql
BEGIN READ ONLY;
SELECT id AS account_id, display_name, created_at
FROM accounts ORDER BY created_at, id;
SELECT count(*) AS null_owners FROM shares WHERE account_id IS NULL;
SELECT count(*) AS orphaned_owners
FROM shares s LEFT JOIN accounts a ON a.id = s.account_id
WHERE s.account_id IS NOT NULL AND a.id IS NULL;
SELECT a.id AS account_id, a.display_name, count(s.id) AS share_count
FROM accounts a LEFT JOIN shares s ON s.account_id = a.id
GROUP BY a.id, a.display_name ORDER BY a.id;
COMMIT;
```

For a disposable rehearsal, use an explicit separate Compose project, fixture credentials, a local test image, and an unused loopback port. Pass Compose global arguments to the same script, for example `bash scripts/deploy.sh --project-name morsel-isolation-rehearsal --env-file /path/to/fixture.env`. Never use the production project, connection, or volumes. Check ordering and stopped-service behavior for migration and startup failures, then verify ownership counts and upgrade/downgrade guards. `npm run test:deploy` checks script sequencing and failure handling with a Docker test double; it does not replace a disposable-stack rehearsal.

Both invalid-owner counts must be zero. The sole legacy account must own every legacy share; newly invited accounts must initially have zero. Use restored-production expected counts, not fixture counts, for production approval.

### External multi-account handoff

- Responsible deployment operator:
  - Prerequisite: required agent checks pass; automatic deployment is disabled; immutable images and a tested backup are available; restored-production ownership/counts and legacy setup prerequisites are verified.
  - Action: choose the maintenance window, stop all old instances and writes, manually dispatch only the approved guarded release, verify ownership counts and API/viewer behavior, and deliver invitation/recovery tokens through a secure channel. Supply real client keys and perform production create/revoke checks. Automated agents must not enroll production owners, issue production grants, create real keys, or perform production writes.
  - Expected result: original shares retain the sole legacy owner, invited accounts start empty, and public capabilities retain their existing behavior without owner metadata.
  - Unverified behavior: production-scale backfill/index lock duration, live backup recovery, instance coordination, and real account-owner enrollment. Do not release until ownership, backup recovery, and old-instance shutdown are verified. Local checks authorize no production changes.
- Account owners:
  - Prerequisite: receive an admin invitation link or operator invitation token and the configured HTTPS origin.
  - Action: enroll a passkey and backup; check login and account identity with supported physical authenticators. To switch, log out and choose the intended account's passkey.
  - Expected result: the chosen credential opens the correct account. Native passkey-picker behavior and physical authenticators remain unverified by virtual-authenticator tests; this is not an additional human approval gate.

### External admin invitation handoff

- Deployment operator:
  - Prerequisite: required local checks and disposable rehearsal pass; immutable images and a tested backup are available. Verify the schema-11 selected-admin query on a restored production copy, then compare the UUID with the deployment.
  - Action: arrange the maintenance window, stop every old instance and writer, use the existing guarded manual deployment, and confirm clean schema 12, the intended admin UUID, user roles, unchanged ownership/capabilities, and role-preserving recovery before reopening service.
  - Expected result: only the intended legacy account is promoted; other accounts retain their data as users; all invitation recipients become users. No key rotation or passkey re-enrollment is required.
  - Unverified behavior: actual production history, backup recovery, lock duration, and instance coordination. Do not release until admin selection, recovery, and old-instance shutdown are verified. This task authorizes no production writes, deployment, release, or workflow dispatch.
- Admin and recipient:
  - Prerequisite: an approved deployed API/viewer pair, the configured HTTPS origin, and a secure messaging channel.
  - Action: manually send an invitation and test registration and backup enrollment with supported physical passkeys. If already signed in, log out or use a private window and reopen the original link.
  - Expected result: one new user registers without cross-account management access. External messaging previews, rewriting, retained message/history copies, native clipboard completion after an already-started write, and physical passkey-picker behavior remain unverified; virtual browsers do not establish them. The application checks before clipboard invocation but cannot cancel a native write already started while authorized. No additional human approval gate is imposed for agent completion.

## Share management rollout and review

The historical rollout notes below describe earlier releases. They do not authorize old writers or old unscoped applications after migration 11; the maintenance and rollback restrictions above take precedence.

Share history originally added migration 7, the `(created_at DESC, id DESC)` index. The task-oriented UI adds migration 8: nullable `admin_label` metadata and a partial index for pending labels. Source content, capability hashes, public preview metadata, limits, counts, and revocation state are not rewritten. No key rotation or account re-enrollment is needed.

### View-count sorting rollout

The `most_views` and `least_views` management sorts require no schema migration, backfill, or new configuration. Deploy the API and viewer together. Verify both orders, equal-count ties, search/status filters, and more than one page against a separate test database. Current version 3 cursors include account binding as well as status, search, and sort; view sorts include a nonnegative view count. Old v1/v2 and foreign-account cursors return 400. Reset to page one.

Counts and status are live between requests. Public reads can move a view-sorted share across the cursor, causing skipped or repeated rows; restart from page one to refresh. No count-order index is added; measure list/count query cost on representative data before rollout.

Historical sorting-only rollback used matching previous API/viewer versions without changing the schema. After migration 11, use only an isolation-capable corrective release; do not restore an old unscoped application. For current corrective releases, clear stale selections and cursors and restart at page one. The historical label rollback below is not permission to remove multi-account isolation.

### Label migration and backfill

1. Retain the previous immutable image and a tested backup. Test migration, backfill, interruption/resume, and rollback on a restored database. Confirm the write window before production.
2. Pause old-version share creation before the final backfill and application cutover. Historically, older writers could insert NULL labels. For migration 11, stop all old instances and writes before migration, not merely creation before backfill.
3. Run the **new release's** migration executable with `-direction up`, using the existing migration service or `GOTOOLCHAIN=go1.26.10 go run ./cmd/migrate -direction up` from `packages/server/`. The command applies schema changes, then processes up to 16 pending documents per loop. Each document is read and committed separately, outside account/session locks; only one source is parsed at a time.
4. If interrupted or cancelled, rerun the same up command. Applied schema migrations stay recorded; completed labels are not rewritten. The command exits unsuccessfully when backfill fails or is cancelled, so do not treat schema version 8 alone as completion.
5. Before opening management, verify `SELECT count(*) FROM shares WHERE admin_label IS NULL` returns zero, with old writers still paused. Deploy the new API and viewer together, then resume client writes.

If management returns `503 label_backfill_required`, check for an incomplete backfill or an older writer and rerun the new migration up command after stopping that writer. The API refuses incomplete search results within the affected account, including zero-match queries; another account's pending labels do not block it. Public capability reads and revocation are independent of label readiness.

Historical generated fixtures measured label backfill of 256 approximately 64 KB sources at 1.27 seconds. Account-scoped list/count measurements on 10,000 generated shares across two owners were: newest 2.598 ms; oldest with active status 5.628 ms; absent-label search with revoked status 3.319 ms; oldest with cursor 1.964 ms; most views 4.286 ms; least views with cursor 4.318 ms. These are generated-fixture measurements, not production guarantees. No extra view-count index is added. The additive schema/index operation can block writes; measure restored production data before choosing a window.

### External review and release handoff

- Deployment operator:
  - Prerequisite: required checks pass; backup, restore, write window, and rollback procedures are confirmed on a restored database.
  - Action: perform the label migration/backfill and API/viewer cutover above; verify direct navigation and refresh for `/manage/shares`, `/manage/api-keys`, `/account`, `/login`, `/recover`, `/setup`, `/invite`, and `/example`.
  - Expected result: account-scoped title search includes the account's legacy shares and existing public URLs retain their behavior.
  - Unverified behavior: production-scale parsing, lock duration, older-writer coordination, and release integration. Do not deploy this data change until backup, recovery, and write-impact procedures are confirmed. Local validation authorizes no production writes.
- Product owner:
  - Prerequisite: fixture captures are available. `npm run test:browser` generates captures under ignored `packages/viewer/test-results/task-ui-*/`, named `task-ui-<width>-<theme>.png`, `home-<width>-<theme>.png`, `manage-preview-<width>.png`, and `manage-api-key-mobile.png`. The 2026-10-23 review session's before captures are local-only under `/tmp/morsel-ui-review/`; they are not repository assets.
  - Action: review homepage entry, retained share controls, compact mobile layout, preview dialogs, one-time-key creation, and destructive-action confirmations at desktop/mobile widths.
  - Expected result: the main tasks are clear, preview does not change the list position, and confirmations identify the affected credential. Subjective visual/usability acceptance remains unverified; no additional human approval gate is imposed.
- Accessibility reviewer:
  - Prerequisite: automated keyboard, axe, text contrast, control-boundary contrast, and focus-ring evidence is available from the browser suite.
  - Action: review supported real browser/screen-reader combinations for preview focus containment, nested chart Escape handling, key-creation announcements, list retries, and passkey-removal confirmation.
  - Expected result: these operations are understandable with assistive technology. Unavailable native assistive-technology behavior remains unverified; automated checks do not establish complete WCAG conformance. No additional human-review gate is imposed.

### Share management rollback

Reverting the UI does not restore revoked shares or API keys. Do not restore the database merely to remove navigation or search changes.

Historical label-only rollback applied only with version 8 as latest and no later migrations. It removed `admin_label` and its pending index with the newer runner while retaining migration 7 and account tables. This is not a current multi-account rollback path. After migration 11, keep isolation-capable API/viewer versions and prefer corrective migration. Never start an old global-query server, even if additive columns remain. Reset stale management cursors at page one; v1/v2 are no longer accepted.

## Backup, restore, and rollback

PostgreSQL is authoritative for shares, plaintext share tokens, accounts, passkeys, API key hashes, sessions, and temporary authentication grants. Database backups include retained share tokens and can restore saved-link retrieval without a separate encryption key. Protect backups as secrets and define recovery point and recovery time objectives. Retain the original key and backup for any legacy encrypted tokens until their recovery is verified.

```sh
pg_dump --format=custom --dbname="$MORSEL_DATABASE_URL" --file=morsel.dump
createdb morsel_restored
pg_restore --clean --if-exists --no-owner \
  --dbname=morsel_restored morsel.dump
```

Back up before every schema change and test migrations on a restored copy. Prefer a corrective migration and an isolation-capable release. The old migration runner rejects unknown versions even for additive schema changes. **Never run an old single-account application against multi-account data, even if schema 11 is retained.** Its global queries can disclose or revoke other accounts' shares. Never automatically roll back or downgrade.

### Role-only rollback (down-12)

Prefer an admin-capable corrective release. If a downgrade is necessary, stop all writes and application instances. Confirm migration 12 is the latest applied version and is clean before using the new runner for exactly one down step. Retain a tested backup and a protected role snapshot:

```sql
BEGIN READ ONLY;
SELECT version, dirty FROM schema_migrations;
SELECT id AS account_id, role, created_at
FROM accounts ORDER BY created_at, id;
SELECT id AS selected_admin_on_rollforward
FROM accounts ORDER BY created_at, id LIMIT 1;
COMMIT;
```

Down-12 removes role assignments only. Retain schema 11 and its ownership/authentication boundaries; never remove migration 11 to roll back invitations. Deploy only a paired isolation-capable schema-11 API/viewer and compatible CLI. That pair disables browser invitation issuance but keeps raw operator invitations and existing grants compatible. Old viewers do not autofill fragment links; use manual token entry instead of regenerating grants or public share tokens. Before rolling forward, compare the retained role snapshot and reverify the deterministic selected UUID on a restored copy. Migration 12 reruns its selection after down-12; do not assume removed assignments survive.

Admin passkey loss uses targeted operator recovery, not role reassignment or automatic promotion at login. Recovery must preserve role. Do not restore the database just to remove this UI feature; a restore can discard later accounts and restore old authentication state. Reconcile all later account, share, key, and session changes before reopening service.

The new runner rejects down-11 before dirty metadata changes when multiple accounts exist. A supported single-account downgrade must be rehearsed with the new executable and must preserve shares, original authentication records, and capabilities while safely clearing new temporary flow/grant variants. This guard does not make an old unscoped server a multi-account rollback target.

On migration failure, leave the service stopped. Inspect the schema and migration dirty state; do not clear dirty metadata without verifying the transactional result. Apply an operator-reviewed correction with an isolation-capable release. Restore a pre-upgrade backup only with operator approval and all writes stopped.

Stop writes before restoring or downgrading. A database restore discards later writes and can restore old session or key state; reconcile later shares and authentication changes before resuming service. Roll back the API and viewer together. Public share URL formats remain stable. See [migrations](development.md#migrations) for the runner.
