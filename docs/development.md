# Development

## Viewer

Requirements: Node.js 24.15 or newer in the 24.x line, or Node.js 26+; npm 11+. Install both npm workspaces from the repository root. The development server proxies `/v1/*`, `/mcp`, the four explicit OAuth protocol routes, and both OAuth well-known documents to the Go API at `127.0.0.1:12647`. It does not proxy the complete `/oauth` prefix: `/oauth/consent` remains the viewer SPA route.

```sh
npm ci
npm run dev --workspace @narumitw/morsel-viewer -- --host localhost --port 5173 --strictPort
```

Run the workspace checks and browser tests:

```sh
npm run ci
npx playwright install chromium
npm run test:browser
```

If port 4173 is occupied, run browser tests with `MORSEL_E2E_PREVIEW_PORT=4181 npm run test:browser` (choose an unused port).

Production has no separate viewer deployment or build-time API hostname. The root Docker build runs Vite, copies `packages/viewer/dist` into the image, and lets the Go service serve both the viewer and API. See [viewer features](viewer.md) for diagram and chart controls and limits.

## Interactive account development

Start PostgreSQL and apply [migrations](#migrations). In one terminal, run the API with a development origin that matches Vite:

```sh
cd packages/server
export MORSEL_DATABASE_URL='postgres://morsel:LOCAL_PASSWORD@127.0.0.1:5432/morsel?sslmode=disable'
export MORSEL_ENVIRONMENT=development
export MORSEL_URL=http://localhost:5173
export MORSEL_ADDRESS=:12647
GOTOOLCHAIN=go1.26.11 go run ./cmd/server
```

In another terminal, start Vite with the command above. Open <http://localhost:5173/login> (or `/setup` for initial account setup). The RP ID is `localhost` (no port); the allowed origin is exactly `http://localhost:5173`. Do not mix `localhost` and `127.0.0.1` in browser URLs. The Vite proxies target `http://127.0.0.1:12647`; relative paths keep the configured browser origin. MCP, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`, `/.well-known/oauth-authorization-server`, and `/.well-known/oauth-protected-resource/mcp` explicitly preserve Host with `changeOrigin: false`. Both development and preview keep `/oauth/consent?request=<handle>` in the SPA; do not proxy all `/oauth` paths or enable application-wide CORS. For MCP, use `http://localhost:5173/mcp` through Vite so the public Host remains consistent with `MORSEL_URL`; an arbitrary backend bind host is rejected. For direct MCP testing at port 12647, instead configure `MORSEL_URL=http://localhost:12647` as in the [local curl example](usage.md#local-curl-example). MCP CORS stays disabled; only public OAuth metadata has credential-free GET/OPTIONS CORS. To exercise native OAuth, point the URL-only [Pi example](usage.md#oauth-and-pi) at `http://localhost:5173/mcp`; the issuer is `http://localhost:5173` and resource is `http://localhost:5173/mcp`.

With the same local database variable set, generate a setup token:

```sh
cd packages/server
GOTOOLCHAIN=go1.26.11 go run ./cmd/account -kind setup
```

The command needs only `MORSEL_DATABASE_URL` and still prints a raw token. Enter the setup token in the form at `/setup`, not a URL, within one hour. Setup creates an `admin`; enroll a backup passkey, then create a client API key. The server needs no API key environment configuration. Client scripts still accept `MORSEL_API_KEY` containing a UI-created key. For another account, use the admin's **Invitations** section at `/manage/invitations`, or keep using `GOTOOLCHAIN=go1.26.11 go run ./cmd/account -kind invite` and manual token entry at `/invite`. All invitations create a `user`; enter separate **Account name** and **Passkey name** values. Only invitation tokens can enter through `/invite#token=<43-character base64url token>`; setup/recovery remain form-only. No grant secret is accepted in a query or path. For lost credentials, use `GOTOOLCHAIN=go1.26.11 go run ./cmd/account -kind recover -account-id ACCOUNT_UUID` and the form at `/recover`; [recovery effects](deployment.md#operator-setup-and-recovery) include session invalidation but not API key revocation.

## Authentication browser tests

The mocked viewer suite (`npm run test:browser`) remains separate from the real Go/PostgreSQL authentication suite:

```sh
export MORSEL_TEST_DATABASE_URL='postgres://morsel:test-only-password@127.0.0.1:5432/morsel_test?sslmode=disable'
export GOTOOLCHAIN=go1.26.11
npx playwright install chromium
npm run test:auth:browser
```

Use a test-only PostgreSQL role with permission to create databases. The harness creates an isolated database, applies migrations, builds the viewer and backend, starts Go on an available dynamic port, and stops Go and removes the database on success or failure. It does not use the interactive service on port 12647. The browser origin is `http://localhost:<selected-port>` and the RP ID is `localhost`; the harness sets a matching `MORSEL_URL`. Direct navigation and refresh use Go's built viewer, not Vite preview. Never point this command at production.

The separate required authentication CI job provisions PostgreSQL, Go, Node.js, and Chromium. It runs the account project before the OAuth project; all nine required OAuth cases and the required account lifecycle must execute without skips. Missing infrastructure, zero executed tests, or skipped required tests must fail the job. This suite does not use `MORSEL_E2E_LIVE`.

## Backend

Requirements: Go 1.26.11+ in the 1.26 line, or Go 1.27.4+; PostgreSQL 17; and Docker for integration tests. These minimum versions include the GO-2026-6859 fix in net/http. Go 1.27.0–1.27.2 are also affected by GO-2026-6809 in the WebAuthn certificate verification path.

```sh
cd packages/server
export GOTOOLCHAIN=go1.26.11
go generate ./...
gofmt -w .
go vet ./...
go test ./...
```

From the repository root, run the PostgreSQL integration and concurrency tests:

```sh
docker run --rm -d --name morsel-test-postgres \
  -e POSTGRES_DB=morsel_test \
  -e POSTGRES_USER=morsel \
  -e POSTGRES_PASSWORD=test-only-password \
  -p 5432:5432 postgres:17.6-alpine3.22
export MORSEL_TEST_DATABASE_URL='postgres://morsel:test-only-password@127.0.0.1:5432/morsel_test?sslmode=disable'
cd packages/server
go test -race ./...
go test -race -count=10 ./internal/share \
  -run TestPostgresRepositoryConcurrentFinalViews
docker stop morsel-test-postgres
```

`go generate` uses the exact `oapi-codegen` version recorded in `go.mod`. Generated-code drift fails CI. Keep `GOTOOLCHAIN=go1.26.11` exported for all backend checks here, or use another supported patched toolchain.

Validate the complete OpenAPI contract, including manually implemented account routes:

```sh
npx --yes @redocly/cli@2.53.2 lint --config packages/server/redocly.yaml packages/server/openapi.yaml
(cd packages/server && export GOTOOLCHAIN=go1.26.11 && \
  go generate ./... && \
  before="$(sha256sum internal/api/openapi.gen.go)" && \
  go generate ./... && \
  test "$before" = "$(sha256sum internal/api/openapi.gen.go)")
```

`packages/server/oapi-codegen.yaml` includes only health and public/Bearer share operations. OAuth protocol/metadata, consent, connected-app, account, invitation, verification, passkey, and saved-link routes are manual handlers; update their contract and viewer types explicitly. Do not expand `include-operation-ids` to generate these routes or change existing generated REST bindings for this feature. Redocly can report `operation-2xx-response` for `/oauth/authorize`, whose successful response is 302; keep the real redirect contract rather than adding a fictional 200. Share-write shapes in the TypeScript client and Markdown CLI have no ownership argument.

## MCP validation

The official Go MCP SDK is pinned to v1.8.0. The advertised and tested versions are `2025-11-25`, `2025-06-18`, and `2025-03-26`. `/mcp` uses stateless Streamable HTTP with JSON responses, without persistent sessions or SSE streams. Every request needs a validated OAuth access token or UI-managed Bearer API key, including initialization and `tools/list`; cookies do not authorize it. Use URL-only OAuth or the custom-header alternative with the [documented headers and tools](usage.md#mcp-clients). OpenAPI includes manual OAuth/account contracts, while generated REST bindings remain limited to the existing health/share routes. `tools/list` supplies MCP input/output schemas.

These commands and evidence requirements are validation instructions, not a report of completed checks. Prepare disposable PostgreSQL with the test database variable above; database tests must execute with zero skips:

```sh
cd packages/server
export GOTOOLCHAIN=go1.26.11
go test -race -v ./internal/api -run MCP
go test -race -v -count=10 ./internal/api -run MCP
go test -race -coverprofile=coverage.out ./...
go test -race -count=10 ./internal/share \
  -run TestPostgresRepositoryConcurrentFinalViews
go mod verify
go vet ./...
test -z "$(gofmt -l .)"
```

Record the commands, toolchain/SDK versions, executed test counts, skips, failures, and secret-free evidence location. Keep MCP evidence separate from historical results below. Required evidence includes:

- Full-router SDK-client initialization, notification, `ping`, discovery, and calls for all advertised versions. Verify normal JSON responses, no session ID or persistent SSE, legacy batch safety, authenticated GET/DELETE `405` with `Allow: POST`, malformed protocol/media/version errors, and no-store on success and failure.
- Bearer enforcement including initialization/discovery, cookie-only denial, key revocation between calls, safe authentication outages, configured Host/default-port normalization, and exact/omitted versus duplicate, `null`, and foreign Origin handling. Verify request/body/document limits, restored deadline/cancellation and safe uncommitted HTTP `504`, security headers, and logs without keys, capabilities, URLs, Markdown, or payloads.
- Explicit schemas, strict types/nulls/unknown fields, exact int64 limits, REST preview/Instant View rules, structured/text agreement, and safe `isError` codes/messages. Test two-account isolation, same-account key interchange, foreign/missing revocation equivalence, idempotent owned revocation, and request-local identity despite supplied session headers.
- REST/MCP interoperability, cross-account capability reads without owner identity, exactly one consumed view per successful retrieval, and concurrent final-view limits. Never retrieve a created share merely to validate it or automatically retry creation/retrieval.

Also run the generator drift check and OpenAPI lint above, root `npm run ci`, the CI govulncheck command, `npm run test:browser`, and required `npm run test:auth:browser` with prepared Chromium and disposable PostgreSQL. Required database/authentication checks need zero skips; do not run the production-only live scenario. Confirm generated REST code is unchanged. Local checks do not establish production proxy behavior or external-client acceptance; retain the [MCP handoff](deployment.md#mcp-routing-and-external-handoff).

### MCP validation evidence

These historical transport results precede native OAuth. They do not establish validation of the OAuth implementation, migration 13, consent UI, or client lifecycle.

Local validation on 2026-11-02 used Go 1.26.10, official Go MCP SDK v1.8.0, Node.js 26, disposable PostgreSQL 17.6, and Chromium:

- Backend race/coverage suite: 632 passing cases including subtests, with zero test skips. All 133 MCP cases passed ten race-detector repetitions (1,330 cases, zero skips). Existing final-view concurrency also passed ten repetitions. Generator drift, formatting, module verification, and vet passed.
- The first remote API CI run exposed a deadline/response-commit race. HTTP and restored SDK contexts can run their timer callbacks in either order. The response writer now checks the absolute deadline before commitment and discards late SDK bytes. Deterministic tests cover both a completed timer and an overdue timer whose `Err` is still nil; lifecycle/commit tests passed 100 race/coverage repetitions with `GOMAXPROCS=2`.
- Root CI: 530 viewer tests, 11 client tests, 33 release-tool tests, and five deployment tests passed. OpenAPI lint, TypeScript checks, and viewer build passed. A live Vite proxy test verifies explicit `changeOrigin: false` and preservation of public Host, Origin, Bearer, and MCP protocol headers.
- Browser suite: 83 passed; the single production-only live scenario was not run. Required real Go/PostgreSQL authentication: one test with 21 executed steps passed, with zero skips. Existing CLI/TypeScript client and account-isolation paths remain covered. All 28 Markdown CLI unit tests also passed.
- The Docker image built with supported Go 1.27.3. Its localhost smoke test ran the documented initialization, notification, discovery, and creation commands, then checked owned revocation and unauthorized denial. PostgreSQL confirmed creation/revocation consumed zero views; no validation read was made.
- npm production audit found zero vulnerabilities. Govulncheck found zero reachable or imported-package vulnerabilities. The existing module-only GO-2026-5932 advisory concerns unused `golang.org/x/crypto/openpgp`, which this application does not import or call.

Only disposable test infrastructure and fixture data were used. Production proxy/WAF behavior and external-client configuration remain unverified in the [MCP handoff](deployment.md#mcp-routing-and-external-handoff). No package publication, version tag, release dispatch, or production deployment was performed.

## Native OAuth validation

Native OAuth uses Fosite v0.49.0 with only code, refresh, and `S256` PKCE handlers, a custom 256-bit opaque/SHA-256 strategy, and patched dependencies. It has no signing/HMAC secret or JWT-key provisioning. Keep the pinned dependency/vulnerability gates, including reachable and imported-package results, separate from unused module-only advisories.

These are reproducible **requirements**, not a report that all checks are complete. Use disposable PostgreSQL and prepared Chromium; required database/browser cases must execute with zero skips. Keep shell tracing off and artifacts secret-free. Do not use the production-only live scenario, physical passkeys as an agent check, or real global client credentials/settings.

From the repository root, with `MORSEL_TEST_DATABASE_URL` pointing to the disposable test role:

```sh
export GOTOOLCHAIN=go1.26.11
(cd packages/server && \
  go test -race -v ./internal/auth ./internal/api ./migrations -run 'OAuth|MCP' && \
  go test -race -v -count=10 ./internal/auth ./internal/api -run 'OAuth|MCP' && \
  go test -race -coverprofile=coverage.out ./... && \
  go test -race -count=10 ./internal/share -run TestPostgresRepositoryConcurrentFinalViews && \
  go mod verify && go vet ./... && test -z "$(gofmt -l .)" && \
  go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...)
npm run ci
npx --yes @redocly/cli@2.53.2 lint --config packages/server/redocly.yaml packages/server/openapi.yaml
npm audit --omit=dev --workspace @narumitw/morsel-viewer
npm pack --workspace @narumitw/morsel-client --dry-run
npm run build --workspace @narumitw/morsel-viewer
npx playwright install chromium
npm run test:browser
npm run test:auth:browser
docker build --tag morsel:oauth-validation .
```

Run the generator drift/idempotence commands above and verify `internal/api/openapi.gen.go` and the include-only generator configuration are unchanged. If Chromium is launched headed under WSLg, preserve existing launch arguments and add `--ozone-platform=wayland`; do not change headless behavior.

Run the local installed-Pi lifecycle gate with an explicit absolute Pi package directory. Pi is an external test tool, not a project dependency. Prepare Go 1.26.11, Chromium, and `MORSEL_TEST_DATABASE_URL` with the same test-only database-creation permissions as the authentication suite:

```sh
node scripts/test-mcp-oauth-pi.mjs \
  --pi-directory /absolute/path/to/@earendil-works/pi-coding-agent
```

Replace the directory argument with the installed package root. Pi 1.4.0 is the selected validation version. The harness builds its own Go service/viewer, creates and removes its isolated database, uses headless virtual passkeys and private temporary client credentials, and does not change user-global Pi configuration. Its default secret-free summary/captures are under ignored `packages/viewer/test-results/mcp-oauth-pi-*/`; optional `--report-directory` must name a new absolute directory. Never point it at production. Retain the exact invocation, client versions, executed cases, and secret-free results before finalizing evidence. The required Go SDK lifecycle cases are in `packages/server/internal/api/mcp_oauth_integration_test.go`, included in the Go commands above. The installed Pi 1.4.0 client sends the RFC 8707 resource during code exchange and refresh. Official Go MCP SDK v1.8.0 integration must use `StreamableClientTransport.OAuthHandler` and `auth.NewAuthorizationCodeHandler` with an explicit resource-aware refresh HTTP transport/`NewTokenSource` hook. Its default `oauth2.Config.TokenSource` omits `resource` on refresh, so that request must fail with 400; do not relax the server's mandatory resource check or claim out-of-box SDK refresh compatibility. Validate the configured hook positively and the default omission negatively.

Required evidence:

- Discovery/challenges match the configured issuer and `<origin>/mcp`, not Host/forwarded headers. Cover credential-free metadata GET/OPTIONS, `resource_metadata`, initial `mcp:shares offline_access`, `insufficient_scope`, no-store, safe 503, and no application/MCP CORS. Preserve legacy keys and all three advertised MCP versions/tools.
- Prove public native DCR, bounded strict JSON/forms, S256-only PKCE, exact redirects and IP-loopback port-only exception, client/redirect/state/issuer/resource/scope binding, no CIMD/outbound metadata fetch, one-use codes, finite database-clock expiry, no scope/resource widening, and no credential-type fallback after storage failure. If refresh scope is supplied it must match the granted canonical scope after order normalization; both narrowing and widening must return `invalid_scope`, never silently regrant the original scope. Pi/configured Go clients omit it; no-refresh access requires new authorization without `offline_access`. OAuth must fail on REST/account writes; cookies/codes/refresh tokens must fail on MCP.
- Prove hash-only credentials and absent verifiers/raw handles/tokens in OAuth storage. Inspect HTTP URLs, Referrer, backend/proxy logs, browser storage, history/shared events, and artifacts for leaks. Existing raw share capabilities remain secret database/backup data; do not claim all persistence is hash-only.
- Exercise code/refresh atomicity, rollback, concurrent redemption, reuse revocation including access, uncertain lost responses without automatic retries, restart/multi-process persistence, fixed absolute family expiry, access-only families, capacity and cleanup retention/batches, and a separate OAuth source-IP/global limiter that ignores forwarded addresses. Repeat focused concurrency/lifecycle cases ten times under the race detector.
- Prove consent shows account/UUID, unverified client name/ID, redirect/resource/permissions/persistent access; no GET/login/preview issuance; explicit approval/denial; twelve-hour freshness only for approval; exact session/account/generation binding; same-account new-session restart; logout, recovery, cross-tab, stale-marker, and duplicate-submission rejection. Test connected-app ownership/revocation, same-name clients in two accounts, keyboard/focus/accessibility, safe callback navigation, and list-only retries.
- Run actual installed Pi and the configured official Go SDK against the built Go service/isolated database: discovery/DCR, virtual-passkey login/consent, calls, access expiry and rotating refresh, registration reuse/new loopback ports, restart/reconnect, denial, revocation, recovery, and reauthorization. Use private client credential directories, never `~/.pi/agent` or real OS credentials. Native browser launching, physical passkeys, callback ownership, and OS keyring behavior remain external.
- Rehearse the built image and guarded script in a separate disposable Compose project. Prove migration 13 up/down/up preserves all legacy tables/roles/authentication/share capability state, old-runner unknown-schema handling, supported schema-12 isolation-capable rollback, failure shutdown, and the exact [OAuth-only restore invalidation SQL](deployment.md#invalidate-restored-oauth-state-before-startup), including pending-request deletion and restored code/access/refresh denial while legacy API keys still work. Never use down-12/11 to disable OAuth.

### Native OAuth validation evidence

Local validation on 2026-11-02 used Go 1.26.10, PostgreSQL 17.6, Node.js 26.11.1, Chromium virtual authenticators, Pi 1.4.0, and official Go MCP SDK v1.8.0:

| Evidence group | Verified result |
| --- | --- |
| Backend / PostgreSQL | Full race/coverage suite: 809 passing cases, zero skipped tests, 79.2% statement coverage. All 160 MCP cases passed ten repetitions (1,600 cases). Existing final-view concurrency passed ten repetitions. Sixteen component tests and controlled OAuth concurrency also passed ten repetitions. |
| Viewer / browser | Root CI passed: 682 viewer, 11 client, 33 release-tool, and five deployment tests. Viewer typecheck/build passed. Ordinary browser suite: 83 passed; only the production-only live case was excluded. Required real-backend account/OAuth suite: nine named tests and 47 checks passed, zero skips. Helper and secret-safe reporter negative checks passed. |
| Actual clients | `scripts/test-mcp-oauth-pi.mjs` passed 13 phases across ten separate Pi processes, one reused DCR registration, five code exchanges, one successful refresh rotation plus expected revoked/recovered refresh failures, and 21 tool calls. Headless passkey consent, denial, restart, revocation/recovery and reauthorization passed. Configured Go SDK lifecycle/final-view/exact-number tests passed 290 cases over ten race repetitions; unconfigured refresh without `resource` was rejected. |
| Contracts / security / build | Generator drift/idempotence, gofmt, module verification, vet, root CI, client package dry-run, and final Docker build passed. npm production audit: zero vulnerabilities. Govulncheck: zero reachable/imported-package findings; only the existing unused-module openpgp advisory remains. Redocly 2.53.2 passed with the expected 302-only authorize warning. The existing Vite large-chunk warning remains. Independent read-only production security/lifecycle review found no material issue. |
| Migration / rollback / restore | Built-image schema 12 → 13 → 12 → 13 rehearsal passed with 18 legacy snapshots. Roles, shares/capabilities, keys, sessions, passkeys, grants, logical schema/indexes and ordering were preserved. Old-runner unknown-version refusal, dirty/partial-migration and replacement-startup failures left the service stopped. The exact OAuth-only restore invalidation SQL denied restored code/access/refresh credentials while legacy clients remained valid. |

Secret-free local evidence is retained under `/tmp/morsel-mcp-oauth-baseline.bjTSTA` (final Go/root/browser/contract/build logs), `/tmp/morsel-oauth-http-tests.7ibBuK` (protocol/concurrency evidence), `/tmp/morsel-pi-real-evidence-verified` (Pi summary and fixture-only consent capture), and `/tmp/morsel-mcp-oauth-rehearsal.cVqPef1V/evidence` (18-snapshot rollback/restore report). The final formatted Pi harness passed again and deleted its raw credential store, browser/service processes, and database. A manual SIGTERM during startup also removed the owned process, temporary directory, and database. Invalid arguments and an existing report-directory collision failed without changing existing files. Docker rehearsal resources and image tags were removed; protected fixture backups remain local with mode `0600`. No image or binary artifact is committed. The final Docker image includes the current `llms.txt` asset, verified by byte comparison.

These temporary paths support the recorded local checks; they are not durable runtime artifacts or production evidence. The [external handoff](deployment.md#external-mcp-handoff) retains production proxy/TLS/WAF, clock/backup/load, physical-passkey/native callback/keyring, and subjective consent checks, including the prior production `/mcp` 404. No production write, deployment, package publication, version tag, or release/workflow dispatch was performed.

## Migrations

Migrations are embedded in the migration executable and protected by a PostgreSQL advisory lock.

```sh
cd packages/server
GOTOOLCHAIN=go1.26.11 MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction up
GOTOOLCHAIN=go1.26.11 MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction down -steps 1
```

For schema version 8 and later, the normal up command also derives missing administrative labels in loops of at most 16 documents, with per-document durable updates. Cancellation leaves completed work intact; rerun up to resume. Direct `migrations.Run` calls in tests apply schema only, so tests that insert legacy rows must explicitly use `share.BackfillLabels` before expecting complete management search. A pending label causes `503 label_backfill_required`, not an incomplete result.

Migration 11 adds account display names, NOT NULL share ownership with restrictive account deletion, the account-leading history index, and monotonic authentication ordering. Within `auth_flows`, only login flows may be unbound. Legacy credentials receive sequence orders before service startup. Pending authentication flows are cleared; sessions, passkeys, API keys, and valid existing grants are preserved. One existing account receives all legacy shares; a fresh empty database is valid. Upgrade preflight rejects shares without an account or more than one legacy account before setting dirty metadata. Complete first setup on the current migration-10 release for ownerless shares; do not guess ownership from keys. Down-11 preflight rejects multiple accounts before setting dirty metadata. Never run the old unscoped application against multi-account data, even with schema 11 retained. See the [maintenance procedure](deployment.md#multi-account-maintenance-upgrade).

Migration 12 adds `accounts.role NOT NULL DEFAULT 'user'` constrained to `admin|user`. It promotes only the oldest existing account ordered by `created_at, id`. Empty databases stay empty until explicit admin setup; all invitation completions insert user explicitly. Recovery preserves the role, and startup does not reassign it. Roles do not bypass share ownership. Before production, verify the selected UUID on a restored production copy using the [read-only schema-11 query](deployment.md#admin-role-upgrade-migration-12).

Down-12 removes role assignments only, not migration 11's ownership boundary. Keep a role snapshot and reverify the selected UUID before rolling forward. Stop every old writer before migration; an old setup writer against an empty upgraded database can create only a user. Use the existing guarded manual deployment, not mixed versions. Paired schema-11 API/viewer/CLI versions keep account isolation and raw invitations but do not autofill fragment links.

Migration 13 is additive and creates `oauth_clients`, `oauth_requests`, `oauth_grants`, and `oauth_tokens`. Up/down/up must preserve every legacy table, shares and raw capabilities, roles, sessions, passkeys, keys, existing grants, generations, and authentication ordering. Down-13 drops OAuth state only; a rollforward requires re-registration/consent. Pause writers and use compatible account-isolation-capable releases and the migration-13 runner. Old runners may reject schema 13. OAuth rollback must not run down-12 or down-11. Restored OAuth families must be invalidated and pending requests deleted before startup with the [documented SQL](deployment.md#invalidate-restored-oauth-state-before-startup); that procedure must not invalidate API keys.

Create legacy test fixtures at the old schema version and run the real migration path. Current-schema shares need explicit owners. Validate two-account isolation, same-account key interchange, foreign/missing 404 equivalence, scoped counts/readiness/link retrieval and verification, v3 cursor binding with v1/v2 rejection, and unchanged public capabilities. Authentication validation includes equal/backwards timestamps, concurrent registration/recovery, consumed in-flight flows, independent recovery, and cross-tab response-marker races. Virtual authenticators do not establish physical passkey-picker behavior. Test output must show required database/browser tests executed, not silently skipped.

The runner rejects dirty, unknown, or gapped migration histories. Apply migrations before starting a newer API. An older runner can reject the new schema's migration version even when changes are additive. Never automatically downgrade production; test migrations and any downgrade on a restored database first. See [backup and rollback](deployment.md#backup-restore-and-rollback) for write-window and authentication cautions.

### Admin invitation validation requirements

These are required checks, not a record of executed tests. Keep new evidence separate from the historical multi-account results below.

- Test zero/one/multiple legacy accounts and equal timestamps at schema 11, then migration 12 up/down/up. Record the selected UUID. Preserve ownership, capabilities, passkeys, session/key/grant bindings, authentication generation, monotonic ordering, and recovery roles. Keep historical fixtures pinned to their intended schema.
- Check admin issuance, user denial, admin-owned API-key denial, exact Origin, CSRF, freshness, strict `{}` and no-query validation, database failures, fixed-bucket rate limits, and concurrent logout/recovery/role loss. Authorization and insertion must share a transaction. Verify 201 URL/expiry, no-store and account marker, hash-only grant storage, and unchanged `IssueGrant`/CLI output and Bearer response models.
- Check one-hour expiry, independent grants, forwarding, single use, concurrent redemption, cancellation, and page/preview fetches that do not consume grants. Check valid signed-in sessions at both begin and finish return `409 sign_out_required` without replacing the session or consuming the grant; invalid/expired cookies may proceed and database failures must fail closed.
- Check strict fragment parsing and cleanup before redirects/shared navigation. Tokens must be absent from HTTP URLs, Referrer, logs, storage, `history.state`, `next`, and the cleaned current entry; Back/Forward must not restore them. Check manual entry, explicit submission, signed-in instructions, reopen-after-cancellation behavior, stale responses, cross-tab identity changes, role loss, clipboard completion/races, and explicit-only retry.
- Run required real Go/PostgreSQL browser tests with zero skips. Prove admin-to-user enrollment and share isolation in both directions, plus unchanged public capabilities, keys, recovery, share controls, CLI behavior, and authentication ordering. Rehearse the guarded deployment and supported down-12 rollback in a separate disposable Compose project. Do not run production scenarios or send real invitations.

External message previews, rewriting, retained copies, browser history copies before cleanup, physical passkey behavior, and production lock duration remain unverified by local fixtures. Retain them in the [operator handoff](deployment.md#external-admin-invitation-handoff), not as additional human approval gates for agent completion.

### Admin invitation validation evidence

Local validation on 2026-10-26 used Go 1.26.10, Node.js 26, disposable PostgreSQL 17.6, and Chromium virtual WebAuthn authenticators:

- Backend race/coverage suite: 498 passing cases including subtests; no failures or skips. Final-view concurrency passed ten repetitions. Invitation authorization-lock and signed-in-finish checks passed ten repetitions, 60 cases with no skips. Generator idempotence, formatting, module verification, and vet passed.
- Root CI: 529 viewer tests, 11 client tests, and five deployment-sequence tests passed. OpenAPI lint, viewer typecheck, and production build passed.
- Browser suite: 83 passed; only the production-only `MORSEL_E2E_LIVE` scenario was excluded. Admin invitation keyboard navigation, overflow, and axe WCAG A/AA checks passed at 320px, 375px, and 1280px. Strict fragment tests reject noncanonical final bits as well as escaped, duplicate, unknown, or invalid-length fields.
- Required real Go/PostgreSQL authentication: one required test with 21 executed steps passed, with zero skips. It covers admin WebUI issuance, independent signed-out user enrollment, manual CLI invitations, preview/GET non-consumption, expiry/replay, signed-in conflict without session replacement, both directions of share isolation, public reads, recovery, and delayed responses/clipboard acknowledgements. HTTP URLs, Referrer, backend logs, storage, and history are checked for token disclosure; PostgreSQL checks verify hash-only grants and one-hour expiry.
- Markdown CLI: 28 Python tests passed. Real-backend CLI and TypeScript client share creation, revocation, and foreign-account denial passed in the authentication suite.
- Docker build and disposable Compose rehearsal passed: schema-11 backup/restore with two enrolled accounts; deterministic admin selection; migration-12 data/authentication preservation; admin issuance and user/API-key denial; invited-user enrollment; role-preserving recovery; supported down-12 to the paired isolation-capable schema-11 application and rollforward; public capabilities; unhealthy replacement shutdown and corrective restart; and fresh explicit-admin setup. Only fixture projects and their volumes were removed.
- Security scans: npm production audit found zero vulnerabilities. Govulncheck found no reachable or imported-package vulnerabilities; one module-only advisory remains in code the application does not import or call.

Clipboard tests prove guards before invocation and rejection of obsolete acknowledgements or repeat writes. A native clipboard write already started while authorized cannot be cancelled. Production admin selection, scale, backup recovery, messaging previews/rewriting/retained copies, and physical passkeys remain external checks in the [admin invitation handoff](deployment.md#external-admin-invitation-handoff). No production deployment or release workflow was dispatched.

## Task-oriented UI validation

The focused component tests cover URL validation, exact-one public reads after submission, separate management sections, cancellation, one-time-key replacement protection and focus, confirmations, list-only retries, retained share controls, and search races. The browser suite adds:

- 1280×800 list density with at least five visible ordinary rows. At 375×800, the first share begins within the first 450px. Preview overflow checks also cover 320px.
- Light, dark, Sepia, Sage, Midnight, and system palette checks on homepage and share management.
- Browser axe WCAG A/AA checks, native form-boundary contrast of at least 3:1, and visible keyboard focus rings of at least 3:1.
- Bounded preview dialogs with keyboard focus containment, list-position restoration, and Escape handling for nested expanded charts.
- Dedicated login, setup, invitation, and recovery routes; safe return destinations; loading, retry, session expiry, and history navigation.
- Key-creation focus, passkey confirmation/cancellation, list-only retries, retained share controls across section/history navigation, and native history warnings for undismissed keys.
- Fixture screenshots under ignored `packages/viewer/test-results/task-ui-*/`: list/home captures, `manage-preview-<width>.png`, and `manage-api-key-mobile.png`. No production content or real keys are used.

Run the standard commands above and `npm run test:auth:browser` against test-only PostgreSQL. Required authentication browser tests use the Go-built viewer and verify real passkeys, route refresh, legacy labels, and session/recovery behavior. The separate opt-in production release scenario is not a required local gate and must not be run against production for this work. Native screen-reader and subjective usability acceptance remain external review items in [deployment handoff](deployment.md#external-review-and-release-handoff).

`npm run test:deploy` uses a Docker test double to check maintenance-script ordering and failure shutdown; it is part of root CI. It does not replace the [disposable Compose rehearsal](deployment.md#maintenance-sequence). Use `bash scripts/deploy.sh` with a separate `--project-name`, fixture environment, local image, and unused loopback port; never use production volumes.

### Historical multi-account validation evidence

These results precede migration 12 and admin invitation links; they do not establish validation of this feature.

Local validation on 2026-10-26 used Go 1.26.10, Node.js 26, disposable PostgreSQL 17.6, and Chromium:

- Backend race/coverage suite: 435 passing cases including subtests; no skipped tests. Final-view concurrency passed ten repetitions. Vet, module verification, formatting, and generator idempotence passed.
- Root CI: 477 viewer tests, 11 client tests, and five deployment-sequence tests passed. OpenAPI lint, viewer typecheck, and production build passed.
- Browser suite: 66 passed; the single production-only `MORSEL_E2E_LIVE` scenario was not run. Required real-backend authentication: one test with 17 steps passed, with no skips.
- Markdown CLI: 28 Python tests passed; real-backend create/revoke and foreign-account denial passed through both CLI and TypeScript clients.
- Disposable Compose rehearsal: migration 10 backup/restore, migration 11 ownership and capability preservation, rejected unsafe downgrade, migration failure shutdown, unhealthy replacement shutdown, and corrective retry passed. Only the named fixture project and its volumes were removed.
- Security checks: npm production audit found no vulnerabilities; govulncheck found no reachable vulnerabilities. Its module-only GO-2026-5932 advisory concerns unused `golang.org/x/crypto/openpgp`, which is not imported by this application.

Production data, physical passkey selection, and native operating-system focus behavior remain unverified. The [operator and account-owner handoff](deployment.md#external-multi-account-handoff) retains these limits. No production release workflow was dispatched.

For backend query/backfill measurements, run `go test -v ./internal/share -run 'Test(LabelDiscovery|AdminQueryDiscovery|BackfillDiscovery)'` from `packages/server/` with `MORSEL_TEST_DATABASE_URL` set. These tests use generated fixtures and isolated schemas; their timings are not production guarantees.

## Releases

Morsel has one repository version in the root `package.json`. The root version must not be older than the latest stable `vX.Y.Z` Git tag, even with pending changesets or an unreleased tag to recover. If the baseline is behind, update only the root version and the two root lockfile version fields. Do this before preparing a version PR. Do not move published tags. Server, viewer, and client changes all use this release target. Workspace package versions are not updated or published by this process.

Add a changeset with the change:

```sh
npm run changeset -- add patch "Fix share rendering."
npm run changeset -- status
```

Use `minor` for a feature or `major` for a breaking change. Each generated `.changeset/*.md` file targets only `@narumitw/morsel`. Commit the file with the code change. Changesets are not required for changes that need no release.

The **Publish** workflow runs on pushes to `main` and through manual dispatch:

1. `node scripts/prepare-release.mjs` checks the root release plan. If the release list is empty, including changesets without release targets, it leaves version files unchanged and skips version PR creation.
   - With a root release, preparation uses the highest pending bump, updates the root version, root lockfile version metadata, and root `CHANGELOG.md`, and removes the consumed changesets.
   - `peter-evans/create-pull-request@v8` commits these files and creates or updates the existing `changeset-release/main` PR branch. The PR body includes the new root changelog entry, not workspace releases. PR creation uses the GitHub API and requires the existing PR permissions.
   - Review these changes and required CI results before merging the version pull request. Version PR preparation also runs when an older release is being recovered.
2. After the version pull request is merged and no changesets remain, `npm run release` creates and pushes one `vX.Y.Z` tag from the checked-out `main` commit.
   - The workflow publishes the container from that tag, creates the GitHub release, then calls **Deploy** with the same tag. GitHub release notes use generated commit notes; Changesets summaries remain in the root changelog.
   - A completed version is a no-op on later pushes. An older version or a missing changelog entry fails before tagging.
3. If container publication or GitHub release creation fails after tagging, manually rerun **Publish** on `main`.
   - The workflow recovers the same unreleased tag without moving it or creating another version.
   - If `main` already contains a newer prepared version, rerun **Publish** after recovery to publish that version.

GitHub Actions must have permission to create pull requests in the repository's **Actions > General** settings. CI runs for a version pull request created with the default GitHub token can require **Approve workflows to run**. Approve and verify the required checks before merging.

Local release tests do not verify Actions authentication or updates to an existing PR. After a workflow change is merged, the release maintainer must inspect the next authorized **Publish** run.

- An empty root release list must skip PR creation.
- A nonempty list must create or update a version PR with root release notes.

Do not dispatch publication or merge a version PR only to test this behavior.

To review a version change locally, run `npm run release:version` on a branch, then `npm run ci` and inspect the diff. This version command does not commit, tag, publish, or deploy. In contrast, `npm run release` is a CI publication command that can push a remote tag; do not use it to preview a release.

Use the repository commands rather than the stock `npx changeset` CLI, which discovers individual npm workspaces. PR preparation uses the custom root-only version command. The PR action does not publish npm packages, create package tags, or create GitHub releases. Repository tag publication runs before version files are prepared. No npm registry URL, npm token, or OIDC permission is needed. Run `npm run test:release` for isolated tests.

**Deploy** is a reusable workflow called only after container publication and GitHub release creation succeed with a nonempty release tag. It checks out that exact tag and names the local image with the checked-out commit SHA, including recovery of an older unreleased tag. Tags pushed with `GITHUB_TOKEN` do not trigger another workflow; the direct call does not depend on that event. The deployment job appears inside the **Publish** run. Ordinary pushes that only prepare a version PR or find an already completed release do not deploy. Version-tag pushes from other credentials remain supported. Manual **Deploy** dispatch can select a trusted repository branch, including a PR head branch, and checks out the commit recorded for that dispatch. Use **Actions > Deploy > Run workflow > Use workflow from** to select the branch. This uses the existing deployment target, not an isolated preview; PR events and branch pushes do not deploy.

Verify the [maintenance requirements](deployment.md#multi-account-maintenance-upgrade) before merging a version PR, starting release recovery, pushing a version tag, or dispatching deployment. If deployment fails after the GitHub release exists, rerun the failed deployment job in the original **Publish** run. A new **Publish** run for that completed version is a no-op and does not retry deployment.

## Repository layout

```text
packages/server/ Go server, static-file serving, OpenAPI contract, and migrations
packages/viewer/ React viewer source and build-time tests
packages/client/ Publishable TypeScript client for the share API
package.json     npm workspace scripts and shared overrides
package-lock.json npm workspace lockfile
docs/            Usage, deployment, design, development, and review notes
.github/         GitHub Actions workflows for CI and deployment
Dockerfile       Production image build
compose.yaml     Local single-origin deployment
```

See the historical [release validation](release-validation.md) and [dependency review](dependency-review.md) notes for v1 release evidence; their commands document the pre-workspace layout.
