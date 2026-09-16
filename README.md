# Morsel

Morsel is a small, self-hosted, API-first Markdown sharing service. One Go service stores capability-protected shares in PostgreSQL and serves the static React viewer on the same origin. The viewer renders Markdown, GitHub Flavored Markdown, syntax-highlighted fenced code, KaTeX, and Mermaid without running authored HTML.

## Architecture

```mermaid
flowchart LR
    Client[CLI / agent / internal app] -->|Bearer API key| Morsel[Go service]
    Reader[Reader] -->|viewer and same-origin API| Morsel
    Morsel --> DB[(PostgreSQL)]
    Morsel -->|hash-route share URL| Client
```

A share is created and consumed through the following sequence:

```mermaid
sequenceDiagram
    actor Creator as CLI / agent
    actor Reader
    participant Viewer as Browser / React viewer
    participant Morsel as Go service
    participant DB as PostgreSQL

    Creator->>Morsel: POST /v1/shares (Bearer API key)
    Morsel->>Morsel: Generate capability and SHA-256 hash
    Morsel->>DB: Store Markdown and capability hash
    DB-->>Morsel: Share metadata
    Morsel-->>Creator: 201 JSON with id and #/s/RAW_CAPABILITY_TOKEN share_url
    Creator-->>Reader: Send share URL
    Reader->>Viewer: Open share URL
    Viewer->>Morsel: GET / (fragment stays in browser)
    Morsel-->>Viewer: React viewer
    Viewer->>Morsel: GET /v1/shares/RAW_CAPABILITY_TOKEN
    Morsel->>Morsel: Hash capability token
    Morsel->>DB: Conditional UPDATE ... RETURNING
    DB-->>Morsel: Markdown and incremented view count
    Morsel-->>Viewer: 200 JSON share containing Markdown (Cache-Control: no-store)
    Viewer->>Viewer: Sanitize and render Markdown
```

The Go service serves `/`, `/assets/*`, `/v1/*`, `/healthz`, and `/readyz` from one domain. PostgreSQL is the only content store and correctness boundary. Morsel v1 has no Redis, object storage, queue, account system, separate static host, or Node.js runtime server.

## Clean start with Docker Compose

Requirements: Docker with Compose and `openssl`.

```sh
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
API_KEY="$(openssl rand -hex 32)"
cat > .env <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
MORSEL_API_KEY=$API_KEY
MORSEL_ENVIRONMENT=development
MORSEL_URL=http://localhost:12647/
MORSEL_PORT=12647
EOF
export MORSEL_API_KEY="$API_KEY"
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:12647/readyz
```

Keep the PostgreSQL password URL-safe because Compose interpolates it into a connection URL.

The root [`compose.yaml`](compose.yaml) builds one Morsel image containing the Go binaries and production viewer, waits for PostgreSQL, runs all pending migrations once, and starts the non-root service. It binds Morsel only to loopback by default. `.env` is ignored by Git and contains production secrets; `.env.example` intentionally contains none.

Stop services without deleting data:

```sh
docker compose down
```

Delete the local database only when data loss is intentional:

```sh
docker compose down --volumes
```

## API examples

Set the API key from `.env` in the current shell without placing it in shell history where possible.

Create a share:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Hello\n\n$x^2$","expires_in":3600,"max_views":3}' \
  http://127.0.0.1:12647/v1/shares
```

The response contains an administrative UUID and a `share_url`. The URL is the only place the raw capability token is returned. Morsel stores only its SHA-256 hash.

Consume one view using the token after `#/s/`:

```sh
curl --fail-with-body http://127.0.0.1:12647/v1/shares/RAW_CAPABILITY_TOKEN
```

Revoke a share by administrative UUID:

```sh
curl --fail-with-body -X DELETE \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  http://127.0.0.1:12647/v1/shares/SHARE_UUID
```

The complete contract is [`api/openapi.yaml`](api/openapi.yaml). Public error bodies contain stable `code` and `message` fields.

## View and availability semantics

- Every successful `GET` consumes exactly one view, including refreshes, command-line requests, crawlers, previews, and bots.
- Morsel does not identify people or deduplicate clients. `max_views` means successful retrievals, not unique human readers.
- The final view is protected by one conditional PostgreSQL `UPDATE ... RETURNING`. Concurrent requests cannot exceed the configured limit.
- Retrieval responses use `Cache-Control: no-store`. Proxies must not cache capability responses.
- Unknown capabilities return `404`. Expired, revoked, and exhausted capabilities return `410` with distinct codes. This improves viewer messages but reveals the state of a capability to anyone who already possesses it.
- Losing a raw capability is irreversible. Revoke the share and create a replacement.

## Configuration

The API reads the following environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MORSEL_DATABASE_URL` | yes | — | PostgreSQL connection URL. |
| `MORSEL_API_KEY` or `MORSEL_API_KEY_FILE` | yes | — | Comma-separated keys or newline-delimited key file. Each key must have at least 32 characters. Both sources may be combined during rotation. |
| `MORSEL_URL` | yes | — | Public single-origin URL used to construct `#/s/<token>` links. |
| `MORSEL_VIEWER_DIR` | no | `../viewer/dist` | Directory containing the production viewer and `index.html`, relative to the usual `api/` working directory; the container sets this to `/srv/viewer`. |
| `MORSEL_ENVIRONMENT` | no | `development` | Set to `production` to require HTTPS public URLs. |
| `MORSEL_ADDRESS` | no | `:12647` | API listen address. |
| `MORSEL_MAX_DOCUMENT_BYTES` | no | `1048576` | UTF-8 Markdown byte limit. |
| `MORSEL_MAX_REQUEST_BYTES` | no | `1114112` | Whole request body limit; must exceed the document limit. |
| `MORSEL_READ_HEADER_TIMEOUT` | no | `5s` | HTTP header timeout. |
| `MORSEL_READ_TIMEOUT` | no | `15s` | HTTP request read timeout. |
| `MORSEL_WRITE_TIMEOUT` | no | `30s` | HTTP response write timeout. |
| `MORSEL_IDLE_TIMEOUT` | no | `60s` | Keep-alive idle timeout. |
| `MORSEL_REQUEST_TIMEOUT` | no | `20s` | Per-request context deadline. |
| `MORSEL_SHUTDOWN_TIMEOUT` | no | `10s` | Graceful shutdown deadline. |
| `MORSEL_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error`. |

Production startup rejects insecure public HTTP URLs, short API keys, empty viewer paths, and invalid limits or timeouts. Errors never echo configured secrets. Morsel does not enable cross-origin browser access; the bundled viewer calls the API on the same origin.

### API-key rotation

1. Configure both the old and new keys, preferably with `MORSEL_API_KEY_FILE`.
2. Restart the API and move all administrative clients to the new key.
3. Remove the old key and restart again.

All configured keys are trusted administrators and may revoke any share.

## Viewer development and production serving

The viewer needs Node.js 24.15+ LTS (or 26+) and npm 11 only at build time. Its development server proxies same-origin `/v1/*` requests to the Go API on `127.0.0.1:12647`.

```sh
cd viewer
npm ci
npm run dev
```

Build and test:

```sh
cd viewer
npm run ci
npx playwright install chromium
npm run test:browser
```

Production has no separate viewer deployment and no build-time API hostname. The root Docker build runs Vite and copies `viewer/dist` into the Morsel image; the Go server then serves those files and `/v1/*` from the same origin.

### Production domain and security headers

Set `MORSEL_URL=https://morsel.narumi.dev/` and route that domain to port 12647 through an HTTPS reverse proxy. The Go server sends CSP, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff` as HTTP response headers. The CSP limits API connections to `'self'`.

A reverse proxy must preserve `X-Request-ID` responses, avoid logging authorization headers, and never cache `/v1/shares/*`. Hash routing keeps the capability out of the initial document request; the viewer sends it only to the same-origin API retrieval endpoint.

## Backend development

Requirements: Go 1.26+, PostgreSQL 17, and Docker for integration tests.

```sh
cd api
go generate ./...
gofmt -w .
go vet ./...
go test ./...
```

Run PostgreSQL integration and concurrency tests:

```sh
docker run --rm -d --name morsel-test-postgres \
  -e POSTGRES_DB=morsel_test -e POSTGRES_USER=morsel -e POSTGRES_PASSWORD=test-only-password \
  -p 5432:5432 postgres:17.6-alpine3.22
export MORSEL_TEST_DATABASE_URL='postgres://morsel:test-only-password@127.0.0.1:5432/morsel_test?sslmode=disable'
cd api
go test -race ./...
go test -race -count=10 ./internal/share -run TestPostgresRepositoryConcurrentFinalViews
docker stop morsel-test-postgres
```

`go generate` uses the exact `oapi-codegen` tool version recorded in `go.mod`. Generated-code drift fails CI.

### Migrations

Migrations are embedded in the migration executable and protected by a PostgreSQL advisory lock.

```sh
cd api
MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction up
MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction down -steps 1
```

The runner refuses dirty, unknown, or gapped migration histories. Run migrations before starting a newer API. Never automatically downgrade production.

## Backup, restore, and rollback

PostgreSQL is authoritative. Define recovery point and recovery time objectives appropriate to the deployment.

```sh
pg_dump --format=custom --dbname="$MORSEL_DATABASE_URL" --file=morsel.dump
createdb morsel_restored
pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" morsel.dump
```

Back up before every schema change and test restores regularly. A failed API release may roll back to the previous immutable image only when that image supports the current schema; otherwise roll forward with a corrective migration. Restore database backups before accepting new writes, then reconcile shares created after the backup according to the documented recovery point objective.

The immutable Morsel image contains both the API and viewer. Roll both back together to a known-good image that supports the current schema; hash-route share URLs remain stable.

## Security model

- Capability tokens contain 256 random bits, are base64url encoded, and are never stored raw.
- Administrative API keys are hashed before constant-time comparison.
- Request logs contain route templates rather than token-bearing paths and omit bodies and authorization headers.
- Authored HTML is disabled. Markdown and KaTeX output pass through a reviewed sanitation schema.
- KaTeX trust is disabled. Mermaid runs sequentially with `securityLevel: "strict"`, source/count limits, and DOMPurify SVG sanitation.
- External links use `noopener noreferrer`; images use `Referrer-Policy: no-referrer` and lazy loading.
- Production serves API and viewer from one HTTPS origin and does not enable browser CORS.

Morsel does not protect a share after its capability URL is disclosed. Revoke exposed shares and rotate exposed administrative keys.

## Repository layout

```text
api/       Go API, static-file serving, OpenAPI contract, and migrations
viewer/    React viewer source and build-time tests
.github/   GitHub Actions workflows (CI and deploy)
Dockerfile    Root production image build
compose.yaml  Root single-domain deployment
```

## License

See [`LICENSE`](LICENSE).
