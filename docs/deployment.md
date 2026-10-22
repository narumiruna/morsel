# Deployment and configuration

For local deployment, use the [Quick start](../README.md#quick-start). Build the image explicitly with `docker build --tag "$MORSEL_IMAGE" .`; [`compose.yaml`](../compose.yaml) has no build definition. Compose starts PostgreSQL, applies migrations, and starts Morsel as a non-root user on loopback. Keep the PostgreSQL password URL-safe because Compose uses it in a connection URL. `.env` is ignored by Git; [`.env.example`](../.env.example) contains no secrets.

## Configuration

The API reads these environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MORSEL_DATABASE_URL` | yes | — | PostgreSQL connection URL. |
| `MORSEL_URL` | yes | — | Public origin for share links and WebAuthn. Non-root paths, queries, fragments, and credentials are rejected. |
| `MORSEL_VIEWER_DIR` | no | `../packages/viewer/dist` | Viewer directory, relative to the usual `api/` working directory. The container uses `/srv/viewer`. |
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

## Operator setup and recovery

The image contains the static `/usr/local/bin/account` executable. It reads only `MORSEL_DATABASE_URL`; it does not require viewer or public-origin configuration. From source, run `cd api` and `go run ./cmd/account -kind setup` or `-kind recover` with that database variable set. Each command prints one raw token; only its hash is stored. Treat the output as a secret. Do not put it in a URL, log, ticket, or shell trace.

For Compose, use the same environment, image, project, and database as the target deployment. Start PostgreSQL and complete migrations first. The image is distroless and has no shell; use the executable directly:

```sh
docker compose run --rm --no-deps --entrypoint /usr/local/bin/account morsel -kind setup
```

1. Open `/account` at the configured browser origin. For production, use <https://morsel.narumi.dev/account>.
2. Enter the token in the setup form within one hour and complete passkey registration. The WebAuthn flow expires after 10 minutes; the browser can end its prompt sooner. The token is single-use; only the first owner can register. Invitations and additional accounts are not implemented.
3. Add a backup passkey. Removal of the last passkey is rejected.
4. Create named API keys and save each raw value in the appropriate client secret store when shown. It is shown only once; only its SHA-256 hash and metadata are stored.

Before setup, health checks and the setup UI work, but privileged share operations are rejected. Existing public capability reads are unchanged.

If all passkeys are lost or compromised, an authorized operator can issue a recovery token:

```sh
docker compose run --rm --no-deps --entrypoint /usr/local/bin/account morsel -kind recover
```

Enter the single-use token in the recovery form at `/account` within one hour and enroll a replacement passkey. Recovery completion replaces old credentials, advances the account authentication generation, and invalidates old sessions, pending authentication flows, verification grants, and recovery grants. It does not delete shares or reset the database. **Recovery does not revoke API keys.** Review and revoke suspect keys separately, update affected clients, and enroll a backup passkey again.

Sessions expire 30 days after login, without sliding renewal. Their persistent cookies survive browser restarts; logout and account recovery still revoke sessions immediately. Key creation, key revocation, share revocation, and passkey changes reuse passkey verification for 12 hours, then require verification again. The UI checks the current server session before each change. Production session cookies remain `Secure`, `HttpOnly`, host-only, and `SameSite=Lax`.

Existing sessions keep their original database expiry and cookie lifetime. After deployment, log out and sign in again to receive a 30-day persistent session. Tokens already issued keep their stored expiry. Longer lifetimes increase the time that a stolen session or unused operator token can remain valid; revoke compromised sessions or issue a replacement operator token.

Authentication POST requests have a fixed limit of 60 attempts per source address and ceremony kind per minute, plus a service-wide limit of 1000 per minute. Account-state reads and key-management requests do not consume ceremony limits. Forwarded client IP headers are not trusted; clients behind the same proxy share source-address limits. Apply per-client abuse controls at the existing trusted reverse proxy when needed. Login attempts have a separate budget from verification, setup, and recovery.

### Rotate or revoke client keys

1. Sign in at `/account`, complete fresh passkey verification, and create a named replacement key.
2. Save its one-time value in the client secret store and update all affected clients. Existing clients and scripts can retain the variable name `MORSEL_API_KEY`.
3. Verify share creation and revocation with the replacement, then revoke the old key in the UI. No server restart is needed.

All owner-issued keys are administrators and can revoke any share, including shares created before this release. Key revocation blocks subsequent requests, not an operation already authorized. Revoking a key does not revoke its shares; revoke exposed shares separately.

## Production deployment and first-release handoff

HTTPS and reverse-proxy provisioning are already in place and are not changed here. Set `MORSEL_ENVIRONMENT=production` and `MORSEL_URL=https://morsel.narumi.dev`. Keep port 12647 behind the existing HTTPS reverse proxy.

The reverse proxy must:

- Preserve the browser `Origin` header unchanged and preserve `X-Request-ID` response headers.
- Never cache `/v1/*` (including authentication and management), `/manage/*`, `/account`, `/account/*`, or `/s/*`; honor `Cache-Control: no-store`.
- Exclude authorization headers, cookies, setup/recovery tokens, WebAuthn payloads, raw keys, request bodies, and raw `/s/<token>` paths from logs. Do not enable shell tracing around secret operations.
- Not replace the configured WebAuthn origin with forwarded request headers. Do not assume arbitrary forwarded client IP headers are trusted.

The Go server sends a Content Security Policy, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. CORS remains disabled. Default hash routing keeps capabilities out of initial document requests. Preview metadata intentionally uses a path capability; the Go logger does not log the raw path.

This release stops accepting all old environment-configured keys. There is no legacy compatibility path. Coordinate a maintenance write window; readers can continue to use existing share URLs when the service is available.

1. Pause automatic deployment and administrative client writes. Keep the previous immutable image and a tested database backup. Test the migration and restore on a separate database.
2. Remove obsolete server key settings, then deploy the API and viewer together and apply migrations. The deployment workflow does not enroll an owner or rotate clients.
3. A human operator must run the setup command against the intended production database, enroll at the HTTPS origin, add a backup passkey, and create replacement client keys. Do not run setup/recovery against production as an automated agent check.
4. A human operator must update client secrets, verify replacement-key create/revoke operations and revoked-key rejection, check public share URLs, and then resume writes.
5. Delete the obsolete GitHub `MORSEL_API_KEY` secret after successful validation. Keep client-side secrets that now contain UI-created keys.

Production enrollment and client rotation are operator handoff steps, not actions performed by the coding agent.

## Share management rollout and review

Share history originally added migration 7, the `(created_at DESC, id DESC)` index. The task-oriented UI adds migration 8: nullable `admin_label` metadata and a partial index for pending labels. Source content, capability hashes, public preview metadata, limits, counts, and revocation state are not rewritten. No key rotation or account re-enrollment is needed.

### View-count sorting rollout

The `most_views` and `least_views` management sorts require no schema migration, backfill, or new configuration. Deploy the API and viewer together. Verify both orders, equal-count ties, search/status filters, and more than one page against a separate test database. Existing v1/v2 creation cursors remain supported. View-sort cursors include a nonnegative view count and bind status, search, and sort.

Counts and status are live between requests. Public reads can move a view-sorted share across the cursor, causing skipped or repeated rows; restart from page one to refresh. No count-order index is added; measure list/count query cost on representative data before rollout.

To roll back only this sorting change, restore the previous API and viewer together without changing the schema. Clear view-sort selections and cursors and restart with `newest` or `oldest`; the previous API does not accept the new sort values or their cursors. The label migration rollback below applies only when also reverting the earlier label release.

### Label migration and backfill

1. Retain the previous immutable image and a tested backup. Test migration, backfill, interruption/resume, and rollback on a restored database. Confirm the write window before production.
2. Pause old-version share creation before the final backfill and application cutover. Older writers can still insert NULL labels; public reads can continue while the service remains available.
3. Run the **new release's** migration executable with `-direction up`, using the existing migration service or `go run ./cmd/migrate -direction up` from `api/`. The command applies schema changes, then processes up to 16 pending documents per loop. Each document is read and committed separately, outside account/session locks; only one source is parsed at a time.
4. If interrupted or cancelled, rerun the same up command. Applied schema migrations stay recorded; completed labels are not rewritten. The command exits unsuccessfully when backfill fails or is cancelled, so do not treat schema version 8 alone as completion.
5. Before opening management, verify `SELECT count(*) FROM shares WHERE admin_label IS NULL` returns zero, with old writers still paused. Deploy the new API and viewer together, then resume client writes.

If management returns `503 label_backfill_required`, check for an incomplete backfill or an older writer and rerun the new migration up command after stopping that writer. The API refuses incomplete search results, including zero-match queries. Public capability reads and revocation are independent of label readiness.

Generated local fixtures measured list/count queries at approximately 4–9 ms across 10,000 shares, and a backfill of 256 approximately 64 KB sources at 1.27 seconds. These are test measurements, not production capacity estimates. The additive schema/index operation can block writes; measure restored production data before choosing a window.

### External review and release handoff

- Deployment operator:
  - Prerequisite: required checks pass; backup, restore, write window, and rollback procedures are confirmed on a restored database.
  - Action: perform the label migration/backfill and API/viewer cutover above; verify direct navigation and refresh for `/manage/shares`, `/manage/api-keys`, `/account`, and `/example`.
  - Expected result: global title search includes legacy shares and existing public URLs retain their behavior.
  - Unverified behavior: production-scale parsing, lock duration, older-writer coordination, and release integration. Do not deploy this data change until backup, recovery, and write-impact procedures are confirmed. Local validation authorizes no production writes.
- Product owner:
  - Prerequisite: fixture captures are available. `npm run test:browser` generates after captures under ignored `packages/viewer/test-results/task-ui-*/`, named `task-ui-<width>-<theme>.png` and `home-<width>-<theme>.png`. The implementation session's before captures are retained under ignored `packages/viewer/test-results/ux-before/`.
  - Action: compare homepage entry, section navigation, list density, preview, and confirmation consequences at desktop/mobile widths.
  - Expected result: the main tasks are clear without the old long-page ordering. Subjective visual/usability acceptance remains unverified; no additional human approval gate is imposed.
- Accessibility reviewer:
  - Prerequisite: automated keyboard, axe, text contrast, control-boundary contrast, and focus-ring evidence is available from the browser suite.
  - Action: review supported real browser/screen-reader combinations for navigation, announcements, focus, and destructive actions.
  - Expected result: these operations are understandable with assistive technology. Unavailable native assistive-technology behavior remains unverified; automated checks do not establish complete WCAG conformance. No additional human-review gate is imposed.

### Share management rollback

Reverting the UI does not restore revoked shares or API keys. Do not restore the database merely to remove navigation or search changes.

The previous application server can run with additive label metadata present, but its migration runner rejects version 8. Prefer retaining the additive schema and using the newer runner when possible. If rollback must start the previous runner, stop writes and use the **new release's** migration executable with `-direction down -steps 1`, only after confirming that version 8 is the latest applied migration and no later migrations exist. This removes only `admin_label`, its pending index, and migration 8's record; keep migration 7 and account tables. Roll back API and viewer together.

Older writers can create pending labels after an application rollback. Rerun the new migration up command before rolling forward again. New v2 cursors are not understood by older servers; reset management to its first page instead of reusing a stale cursor. Existing v1 cursors remain valid for empty search with newest-first order.

## Backup, restore, and rollback

PostgreSQL is authoritative for shares, accounts, passkeys, API key hashes, sessions, and temporary authentication grants. Protect backups as secrets and define recovery point and recovery time objectives.

```sh
pg_dump --format=custom --dbname="$MORSEL_DATABASE_URL" --file=morsel.dump
createdb morsel_restored
pg_restore --clean --if-exists --no-owner \
  --dbname=morsel_restored morsel.dump
```

Back up before every schema change and test migrations on a restored copy. After accounts or keys exist, prefer a corrective migration and roll forward. The old migration runner rejects unknown migration versions: an older image may not start its migration service against the upgraded schema even when changes are additive. Do not automatically downgrade. Test any downgrade on a restored copy first; reverting authentication also requires the previous server key and matching client configuration.

Stop writes before restoring or downgrading. A database restore discards later writes and can restore old session or key state; reconcile later shares and authentication changes before resuming service. Roll back the API and viewer together. Public share URL formats remain stable. See [migrations](development.md#migrations) for the runner.
