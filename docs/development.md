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
cd api
export MORSEL_DATABASE_URL='postgres://morsel:LOCAL_PASSWORD@127.0.0.1:5432/morsel?sslmode=disable'
export MORSEL_ENVIRONMENT=development
export MORSEL_URL=http://localhost:5173
export MORSEL_ADDRESS=:12647
go run ./cmd/server
```

In another terminal, start Vite with the command above. Open <http://localhost:5173/login> (or `/setup` for initial account setup). The RP ID is `localhost` (no port); the allowed origin is exactly `http://localhost:5173`. Do not mix `localhost` and `127.0.0.1` in browser URLs. The existing Vite `/v1` proxy still targets `http://127.0.0.1:12647`; relative API paths keep cookies and Origin checks at the browser origin. CORS stays disabled.

With the same local database variable set, generate a setup token:

```sh
cd api
go run ./cmd/account -kind setup
```

The command needs only `MORSEL_DATABASE_URL`. Enter the token in the form at `/setup`, not a URL, within one hour. Enroll the first passkey and a backup, then create a client API key. The server needs no API key environment configuration. Client scripts still accept `MORSEL_API_KEY` containing a UI-created key. For lost credentials, use `go run ./cmd/account -kind recover` and the form at `/recover`; [recovery effects](deployment.md#operator-setup-and-recovery) include session invalidation but not API key revocation.

## Authentication browser tests

The mocked viewer suite (`npm run test:browser`) remains separate from the real Go/PostgreSQL authentication suite:

```sh
export MORSEL_TEST_DATABASE_URL='postgres://morsel:test-only-password@127.0.0.1:5432/morsel_test?sslmode=disable'
npx playwright install chromium
npm run test:auth:browser
```

Use a test-only PostgreSQL role with permission to create databases. The harness creates an isolated database, applies migrations, builds the viewer and backend, starts Go on an available dynamic port, and stops Go and removes the database on success or failure. It does not use the interactive service on port 12647. The browser origin is `http://localhost:<selected-port>` and the RP ID is `localhost`; the harness sets a matching `MORSEL_URL`. Direct navigation and refresh use Go's built viewer, not Vite preview. Never point this command at production.

The separate required authentication CI job provisions PostgreSQL, Go, Node.js, and Chromium. Missing infrastructure, zero executed tests, or skipped required tests must fail the job. This suite does not use `MORSEL_E2E_LIVE`.

## Backend

Requirements: Go 1.26.10+ in the 1.26 line, or Go 1.27.3+; PostgreSQL 17; and Docker for integration tests. Go 1.27.0–1.27.2 are affected by GO-2026-6809 in the WebAuthn certificate verification path.

```sh
cd api
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
cd api
go test -race ./...
go test -race -count=10 ./internal/share \
  -run TestPostgresRepositoryConcurrentFinalViews
docker stop morsel-test-postgres
```

`go generate` uses the exact `oapi-codegen` version recorded in `go.mod`. Generated-code drift fails CI.

## Migrations

Migrations are embedded in the migration executable and protected by a PostgreSQL advisory lock.

```sh
cd api
MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction up
MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction down -steps 1
```

For schema version 8 and later, the normal up command also derives missing administrative labels in loops of at most 16 documents, with per-document durable updates. Cancellation leaves completed work intact; rerun up to resume. Direct `migrations.Run` calls in tests apply schema only, so tests that insert legacy rows must explicitly use `share.BackfillLabels` before expecting complete management search. A pending label causes `503 label_backfill_required`, not an incomplete result.

The runner rejects dirty, unknown, or gapped migration histories. Apply migrations before starting a newer API. An older runner can reject the new schema's migration version even when changes are additive. Never automatically downgrade production; test migrations and any downgrade on a restored database first. See [backup and rollback](deployment.md#backup-restore-and-rollback) for write-window and authentication cautions.

## Task-oriented UI validation

The focused component tests cover URL validation, exact-one public reads after submission, separate management sections, cancellation, one-time-key replacement protection and focus, confirmations, list-only retries, retained share controls, and search races. The browser suite adds:

- 1280×800 list density with at least five visible ordinary rows. At 375×800, the first share begins within the first 450px. Preview overflow checks also cover 320px.
- Light, dark, Sepia, Sage, Midnight, and system palette checks on homepage and share management.
- Browser axe WCAG A/AA checks, native form-boundary contrast of at least 3:1, and visible keyboard focus rings of at least 3:1.
- Bounded preview dialogs with keyboard focus containment, list-position restoration, and Escape handling for nested expanded charts.
- Dedicated login, setup, and recovery routes; safe return destinations; loading, retry, session expiry, and history navigation.
- Key-creation focus, passkey confirmation/cancellation, list-only retries, retained share controls across section/history navigation, and native history warnings for undismissed keys.
- Fixture screenshots under ignored `packages/viewer/test-results/task-ui-*/`: list/home captures, `manage-preview-<width>.png`, and `manage-api-key-mobile.png`. No production content or real keys are used.

Run the standard commands above and `npm run test:auth:browser` against test-only PostgreSQL. Required authentication browser tests use the Go-built viewer and verify real passkeys, route refresh, legacy labels, and session/recovery behavior. The separate opt-in production release scenario is not a required local gate and must not be run against production for this work. Native screen-reader and subjective usability acceptance remain external review items in [deployment handoff](deployment.md#external-review-and-release-handoff).

For backend query/backfill measurements, run `go test -v ./internal/share -run 'Test(LabelDiscovery|AdminQueryDiscovery|BackfillDiscovery)'` from `api/` with `MORSEL_TEST_DATABASE_URL` set. These tests use generated fixtures and isolated schemas; their timings are not production guarantees.

## Repository layout

```text
api/             Go API, static-file serving, OpenAPI contract, and migrations
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
