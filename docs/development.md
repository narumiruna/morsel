# Development

## Viewer

Requirements: Node.js 24.15 or newer in the 24.x line, or Node.js 26+; npm 11+. Install both npm workspaces from the repository root. The development server proxies `/v1/*` requests to the Go API at `127.0.0.1:12647`.

```sh
npm ci
npm run dev
```

Run the workspace checks and browser tests:

```sh
npm run ci
npx playwright install chromium
npm run test:browser
```

If port 4173 is occupied, run browser tests with `MORSEL_E2E_PREVIEW_PORT=4181 npm run test:browser` (choose an unused port).

Production has no separate viewer deployment or build-time API hostname. The root Docker build runs Vite, copies `packages/viewer/dist` into the image, and lets the Go service serve both the viewer and API. See [viewer features](viewer.md) for diagram and chart controls and limits.

## Backend

Requirements: Go 1.26.6+, PostgreSQL 17, and Docker for integration tests.

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

The runner rejects dirty, unknown, or gapped migration histories. Apply migrations before starting a newer API. Never automatically downgrade production.

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
