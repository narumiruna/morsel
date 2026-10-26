# Development

## Viewer

Requirements: Node.js 24.15 or newer in the 24.x line, or Node.js 26+; npm 11+. Install both npm workspaces from the repository root. The development server proxies `/v1/*` requests to the Go API at `127.0.0.1:12647`.

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
GOTOOLCHAIN=go1.26.10 go run ./cmd/server
```

In another terminal, start Vite with the command above. Open <http://localhost:5173/login> (or `/setup` for initial account setup). The RP ID is `localhost` (no port); the allowed origin is exactly `http://localhost:5173`. Do not mix `localhost` and `127.0.0.1` in browser URLs. The existing Vite `/v1` proxy still targets `http://127.0.0.1:12647`; relative API paths keep cookies and Origin checks at the browser origin. CORS stays disabled.

With the same local database variable set, generate a setup token:

```sh
cd packages/server
GOTOOLCHAIN=go1.26.10 go run ./cmd/account -kind setup
```

The command needs only `MORSEL_DATABASE_URL` and still prints a raw token. Enter the setup token in the form at `/setup`, not a URL, within one hour. Setup creates an `admin`; enroll a backup passkey, then create a client API key. The server needs no API key environment configuration. Client scripts still accept `MORSEL_API_KEY` containing a UI-created key. For another account, use the admin's **Invitations** section at `/manage/invitations`, or keep using `GOTOOLCHAIN=go1.26.10 go run ./cmd/account -kind invite` and manual token entry at `/invite`. All invitations create a `user`; enter separate **Account name** and **Passkey name** values. Only invitation tokens can enter through `/invite#token=<43-character base64url token>`; setup/recovery remain form-only. No grant secret is accepted in a query or path. For lost credentials, use `GOTOOLCHAIN=go1.26.10 go run ./cmd/account -kind recover -account-id ACCOUNT_UUID` and the form at `/recover`; [recovery effects](deployment.md#operator-setup-and-recovery) include session invalidation but not API key revocation.

## Authentication browser tests

The mocked viewer suite (`npm run test:browser`) remains separate from the real Go/PostgreSQL authentication suite:

```sh
export MORSEL_TEST_DATABASE_URL='postgres://morsel:test-only-password@127.0.0.1:5432/morsel_test?sslmode=disable'
export GOTOOLCHAIN=go1.26.10
npx playwright install chromium
npm run test:auth:browser
```

Use a test-only PostgreSQL role with permission to create databases. The harness creates an isolated database, applies migrations, builds the viewer and backend, starts Go on an available dynamic port, and stops Go and removes the database on success or failure. It does not use the interactive service on port 12647. The browser origin is `http://localhost:<selected-port>` and the RP ID is `localhost`; the harness sets a matching `MORSEL_URL`. Direct navigation and refresh use Go's built viewer, not Vite preview. Never point this command at production.

The separate required authentication CI job provisions PostgreSQL, Go, Node.js, and Chromium. Missing infrastructure, zero executed tests, or skipped required tests must fail the job. This suite does not use `MORSEL_E2E_LIVE`.

## Backend

Requirements: Go 1.26.10+ in the 1.26 line, or Go 1.27.3+; PostgreSQL 17; and Docker for integration tests. Go 1.27.0–1.27.2 are affected by GO-2026-6809 in the WebAuthn certificate verification path.

```sh
cd packages/server
export GOTOOLCHAIN=go1.26.10
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

`go generate` uses the exact `oapi-codegen` version recorded in `go.mod`. Generated-code drift fails CI. Keep `GOTOOLCHAIN=go1.26.10` exported for all backend checks here, or use another supported patched toolchain.

Validate the complete OpenAPI contract, including manually implemented account routes:

```sh
npx --yes @redocly/cli@2.53.2 lint --config packages/server/redocly.yaml packages/server/openapi.yaml
(cd packages/server && export GOTOOLCHAIN=go1.26.10 && \
  go generate ./... && \
  before="$(sha256sum internal/api/openapi.gen.go)" && \
  go generate ./... && \
  test "$before" = "$(sha256sum internal/api/openapi.gen.go)")
```

`packages/server/oapi-codegen.yaml` includes only health and public/Bearer share operations. Account, invitation, verification, passkey, and saved-link routes are manual handlers; update their contract and viewer types explicitly. Share-write shapes in the TypeScript client and Markdown CLI have no ownership argument.

## Migrations

Migrations are embedded in the migration executable and protected by a PostgreSQL advisory lock.

```sh
cd packages/server
GOTOOLCHAIN=go1.26.10 MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction up
GOTOOLCHAIN=go1.26.10 MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction down -steps 1
```

For schema version 8 and later, the normal up command also derives missing administrative labels in loops of at most 16 documents, with per-document durable updates. Cancellation leaves completed work intact; rerun up to resume. Direct `migrations.Run` calls in tests apply schema only, so tests that insert legacy rows must explicitly use `share.BackfillLabels` before expecting complete management search. A pending label causes `503 label_backfill_required`, not an incomplete result.

Migration 11 adds account display names, NOT NULL share ownership with restrictive account deletion, the account-leading history index, and monotonic authentication ordering. Only login flows may be unbound. Legacy credentials receive sequence orders before service startup. Pending authentication flows are cleared; sessions, passkeys, API keys, and valid existing grants are preserved. One existing account receives all legacy shares; a fresh empty database is valid. Upgrade preflight rejects shares without an account or more than one legacy account before setting dirty metadata. Complete first setup on the current migration-10 release for ownerless shares; do not guess ownership from keys. Down-11 preflight rejects multiple accounts before setting dirty metadata. Never run the old unscoped application against multi-account data, even with schema 11 retained. See the [maintenance procedure](deployment.md#multi-account-maintenance-upgrade).

Migration 12 adds `accounts.role NOT NULL DEFAULT 'user'` constrained to `admin|user`. It promotes only the oldest existing account ordered by `created_at, id`. Empty databases stay empty until explicit admin setup; all invitation completions insert user explicitly. Recovery preserves the role, and startup does not reassign it. Roles do not bypass share ownership. Before production, verify the selected UUID on a restored production copy using the [read-only schema-11 query](deployment.md#admin-role-upgrade-migration-12).

Down-12 removes role assignments only, not migration 11's ownership boundary. Keep a role snapshot and reverify the selected UUID before rolling forward. Stop every old writer before migration; an old setup writer against an empty upgraded database can create only a user. Use the existing guarded manual deployment, not mixed versions. Paired schema-11 API/viewer/CLI versions keep account isolation and raw invitations but do not autofill fragment links.

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

1. With pending changesets, `changesets/action@v2` creates or updates a version pull request using `npm run release:version`.
   - The action uses Git CLI to commit and push its version branch. PR creation still uses the GitHub API and requires the existing PR permissions.
   - The command uses the highest pending bump, updates the root version, root lockfile version metadata, and root `CHANGELOG.md`, and removes the consumed changesets.
   - Review these changes and required CI results before merging the version pull request. Version PR preparation also runs when an older release is being recovered.
2. After the version pull request is merged and no changesets remain, `npm run release` creates and pushes one `vX.Y.Z` tag from the checked-out `main` commit.
   - The workflow publishes the container from that tag, then creates the GitHub release. GitHub release notes use generated commit notes; Changesets summaries remain in the root changelog.
   - A completed version is a no-op on later pushes. An older version or a missing changelog entry fails before tagging.
3. If container publication or GitHub release creation fails after tagging, manually rerun **Publish** on `main`.
   - The workflow recovers the same unreleased tag without moving it or creating another version.
   - If `main` already contains a newer prepared version, rerun **Publish** after recovery to publish that version.

GitHub Actions must have permission to create pull requests in the repository's **Actions > General** settings. CI runs for a version pull request created with the default GitHub token can require **Approve workflows to run**. Approve and verify the required checks before merging.

To review a version change locally, run `npm run release:version` on a branch, then `npm run ci` and inspect the diff. This version command does not commit, tag, publish, or deploy. In contrast, `npm run release` is a CI publication command that can push a remote tag; do not use it to preview a release.

Use the repository commands rather than the stock `npx changeset` CLI, which discovers individual npm workspaces. The action uses the custom root-only version command; its built-in npm publisher, package tags, and GitHub releases are disabled. Repository tag publication runs before the action can check out its version branch. No npm registry URL, npm token, or OIDC permission is needed. Run `npm run test:release` for isolated tests.

Deployment remains a separate manual workflow subject to the [maintenance requirements](deployment.md#multi-account-maintenance-upgrade). Publishing a container or GitHub release does not deploy services or apply migrations.

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
