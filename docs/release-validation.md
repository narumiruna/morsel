# Release validation

Validated for the Morsel v1 release candidate on 2026-09-16.

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
VITE_API_BASE_URL=https://api.morsel.invalid VITE_BASE_PATH=/morsel/ npm run build
npm audit --omit=dev
npm run test:browser
```

All commands passed. Vitest ran 24 unit/component tests. Playwright passed the production-build CSP, GFM, KaTeX, Mermaid, one-request, responsive, and keyboard checks. The generated `index.html` used `/morsel/` asset paths, an exact `connect-src https://api.morsel.invalid`, and `Referrer-Policy: no-referrer` without API credentials.

## Production-stack acceptance

The following flow used `docker compose up -d --build --wait`, the production API image, PostgreSQL 17.6, and the production Vite preview build:

```sh
cd viewer
MORSEL_E2E_LIVE=1 \
MORSEL_E2E_API_KEY="$MORSEL_API_KEYS" \
npm run test:browser -- --grep 'release acceptance flow'
```

The browser rendered GFM, KaTeX, and Mermaid. Ten concurrent retrievals of a three-view share produced exactly three `200` and seven `410` responses. Separate shares passed revocation and expiration checks. API logs used `/v1/shares/{share}` route templates, and explicit scans found neither the API key nor a raw capability-token path in logs or built assets.

## Packaging and workflow checks

```sh
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7

docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:0.69.3 image --skip-version-check --scanners vuln \
  --severity HIGH,CRITICAL --exit-code 1 morsel-api:test
```

Actionlint passed. Trivy reported zero high/critical findings for the Debian image and both Go binaries. See [dependency-review.md](dependency-review.md) for license and vulnerability details.
