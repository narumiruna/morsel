# Morsel

Morsel is a small, self-hosted, API-first Markdown sharing service. The Go API stores capability-protected shares in PostgreSQL. A static React viewer renders Markdown, GitHub Flavored Markdown, KaTeX, and Mermaid without running authored HTML.

## Architecture

```mermaid
flowchart LR
    Client[CLI / agent / internal app] -->|Bearer API key| API[Go API]
    API --> DB[(PostgreSQL)]
    API -->|hash-route share URL| Client
    Reader[Reader] --> Viewer[Static React viewer]
    Viewer -->|capability token| API
```

PostgreSQL is the only content store and correctness boundary. Morsel v1 has no Redis, object storage, queue, account system, or Node.js server.

## Clean start with Docker Compose

Requirements: Docker with Compose and `openssl`.

```sh
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
API_KEY="$(openssl rand -hex 32)"
cat > .env <<EOF
MORSEL_POSTGRES_PASSWORD=$POSTGRES_PASSWORD
MORSEL_API_KEYS=$API_KEY
MORSEL_ENVIRONMENT=development
MORSEL_ALLOWED_ORIGINS=http://localhost:5173
MORSEL_PUBLIC_VIEWER_URL=http://localhost:5173/
MORSEL_PORT=8080
EOF
export MORSEL_API_KEY="$API_KEY"
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:8080/readyz
```

Keep the PostgreSQL password URL-safe because Compose interpolates it into a connection URL.

Compose waits for PostgreSQL, runs all pending migrations once, and then starts the non-root API container. It binds the API only to loopback by default. `.env` is ignored by Git and contains production secrets; `.env.example` intentionally contains none.

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
  http://127.0.0.1:8080/v1/shares
```

The response contains an administrative UUID and a `share_url`. The URL is the only place the raw capability token is returned. Morsel stores only its SHA-256 hash.

Consume one view using the token after `#/s/`:

```sh
curl --fail-with-body http://127.0.0.1:8080/v1/shares/RAW_CAPABILITY_TOKEN
```

Revoke a share by administrative UUID:

```sh
curl --fail-with-body -X DELETE \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  http://127.0.0.1:8080/v1/shares/SHARE_UUID
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
| `MORSEL_API_KEYS` or `MORSEL_API_KEYS_FILE` | yes | — | Comma-separated keys or newline-delimited key file. Each key must have at least 32 characters. Both sources may be combined during rotation. |
| `MORSEL_ALLOWED_ORIGINS` or `MORSEL_ALLOWED_ORIGINS_FILE` | yes | — | Exact comma/newline-separated viewer origins. Wildcards, paths, and credentials are rejected. |
| `MORSEL_PUBLIC_VIEWER_URL` | yes | — | Base URL used to construct `#/s/<token>` links. |
| `MORSEL_ENVIRONMENT` | no | `development` | Set to `production` to require HTTPS public URLs. |
| `MORSEL_ADDRESS` | no | `:8080` | API listen address. |
| `MORSEL_MAX_DOCUMENT_BYTES` | no | `1048576` | UTF-8 Markdown byte limit. |
| `MORSEL_MAX_REQUEST_BYTES` | no | `1114112` | Whole request body limit; must exceed the document limit. |
| `MORSEL_READ_HEADER_TIMEOUT` | no | `5s` | HTTP header timeout. |
| `MORSEL_READ_TIMEOUT` | no | `15s` | HTTP request read timeout. |
| `MORSEL_WRITE_TIMEOUT` | no | `30s` | HTTP response write timeout. |
| `MORSEL_IDLE_TIMEOUT` | no | `60s` | Keep-alive idle timeout. |
| `MORSEL_REQUEST_TIMEOUT` | no | `20s` | Per-request context deadline. |
| `MORSEL_SHUTDOWN_TIMEOUT` | no | `10s` | Graceful shutdown deadline. |
| `MORSEL_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error`. |

Production startup rejects wildcard CORS, insecure public HTTP URLs, malformed origins, short API keys, and invalid limits or timeouts. Errors never echo configured secrets.

### API-key rotation

1. Configure both the old and new keys, preferably with `MORSEL_API_KEYS_FILE`.
2. Restart the API and move all administrative clients to the new key.
3. Remove the old key and restart again.

All configured keys are trusted administrators and may revoke any share.

## Viewer development and deployment

The viewer needs Node.js 24 and npm 11 only at build time.

```sh
cd viewer
npm ci
VITE_API_BASE_URL=http://127.0.0.1:8080 npm run dev
```

Build and test:

```sh
cd viewer
npm run ci
npx playwright install chromium
npm run test:browser
```

`VITE_API_BASE_URL` is public and contains no credential. `VITE_BASE_PATH` controls the GitHub Pages subpath and defaults to `/`. Changing either requires rebuilding the viewer.

The Pages workflow deploys only `viewer/dist`. Configure the repository variable `MORSEL_API_BASE_URL` to the production HTTPS API origin, enable GitHub Pages with **GitHub Actions** as its source, and allow that exact Pages or custom-domain origin in the API configuration. Hash routing keeps capability tokens out of static-host request logs.

### CSP and GitHub Pages limitation

The production build inserts a Content Security Policy meta tag and `Referrer-Policy: no-referrer`. GitHub Pages cannot set arbitrary response headers. Meta CSP cannot enforce header-only directives such as `frame-ancestors`, cannot protect the response before the document parser reaches the tag, and is weaker than a response header. Deploy `viewer/dist` behind a configurable static host or reverse proxy when strict security headers are required.

A custom domain does not change existing hash routes, but requires rebuilding with the correct base path/API origin and updating exact-origin CORS. Serve both the API and viewer over HTTPS. Put the API behind a reverse proxy that preserves `X-Request-ID` responses, does not log authorization headers, and does not cache `/v1/shares/*`.

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

GitHub Pages artifacts are immutable. Roll the viewer back by redeploying a known-good commit; hash-route share URLs remain stable.

## Security model

- Capability tokens contain 256 random bits, are base64url encoded, and are never stored raw.
- Administrative API keys are hashed before constant-time comparison.
- Request logs contain route templates rather than token-bearing paths and omit bodies and authorization headers.
- Authored HTML is disabled. Markdown and KaTeX output pass through a reviewed sanitation schema.
- KaTeX trust is disabled. Mermaid runs sequentially with `securityLevel: "strict"`, source/count limits, and DOMPurify SVG sanitation.
- External links use `noopener noreferrer`; images use `Referrer-Policy: no-referrer` and lazy loading.
- Production must use HTTPS for both API and viewer.

Morsel does not protect a share after its capability URL is disclosed. Revoke exposed shares and rotate exposed administrative keys.

## Repository layout

```text
api/       Go API, OpenAPI contract, migrations, and container
viewer/    React static viewer
.github/   API CI and GitHub Pages workflows
compose.yaml
```

## License

See [`LICENSE`](LICENSE).
