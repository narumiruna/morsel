# Release validation

Validated for the Morsel v1 release candidate on 2026-09-16. The commands below record the original, pre-workspace layout. For the current layout, install from the repository root with `npm ci`, run `npm run ci` and `npm run test:browser`, and use `npm audit --omit=dev --workspace @morsel/viewer`. The viewer now lives in `packages/viewer/`.

## API and PostgreSQL

A disposable `postgres:17.6-alpine3.22` instance supplied `MORSEL_TEST_DATABASE_URL` while these commands ran:

```sh
cd api
go generate ./...
test -z "$(gofmt -l .)"
git diff --exit-code -- internal/api/openapi.gen.go
go mod verify
go vet ./...
go test -race -coverprofile=coverage.out ./...
go test -race -count=10 ./internal/share -run TestPostgresRepositoryConcurrentFinalViews
go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
```

All commands passed. The integration suite exercised migration up/down/up, dirty and unknown migration rejection, PostgreSQL-clock expiration, revocation, unlimited and limited shares, database constraints, token collisions, and concurrent final views.

## Viewer

```sh
cd viewer
npm ci
npm run openapi:lint
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
npm run test:browser
```

All commands passed. Vitest ran 25 unit/component tests. Playwright passed the production-build CSP, GFM, syntax highlighting, KaTeX, Mermaid labels, one-request, responsive, and keyboard checks. The viewer uses root-relative assets and `/v1/*` requests without an API hostname or credential. Preview and production responses set `connect-src 'self'` and `Referrer-Policy: no-referrer` headers.

## Production-stack acceptance

The following flow used `docker compose up -d --build --wait`, the single-domain production image containing the Go API and Vite viewer, and PostgreSQL 17.6:

```sh
cd viewer
MORSEL_E2E_LIVE=1 \
MORSEL_E2E_API_KEY="$MORSEL_API_KEY" \
npm run test:browser -- --grep 'release acceptance flow'
```

The browser rendered GFM, KaTeX, and Mermaid. Ten concurrent retrievals of a three-view share produced exactly three `200` and seven `410` responses. Separate shares passed revocation and expiration checks. API logs used `/v1/shares/{share}` route templates, and explicit scans found neither the API key nor a raw capability-token path in logs or built assets.

## Packaging and workflow checks

```sh
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7

docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:0.69.3 image --skip-version-check --scanners vuln \
  --severity HIGH,CRITICAL --exit-code 1 morsel:test
```

Actionlint passed. Trivy reported zero high/critical findings for the Debian image and both Go binaries. See [dependency-review.md](dependency-review.md) for license and vulnerability details.
