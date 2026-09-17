# Morsel

Morsel is a small, self-hosted service for sharing Markdown through revocable capability URLs. One Go service exposes the API and serves the React viewer from the same origin; PostgreSQL is the only content store.

Morsel supports:

- API-first share creation and revocation
- optional expiration times, view limits, standards-based Open Graph previews, and opt-in Telegram Instant View articles
- GitHub Flavored Markdown, syntax highlighting, KaTeX, Mermaid, and Vega-Lite charts
- sanitized output with authored HTML disabled
- a single production image with no Node.js runtime

## Quick start

Requirements: Docker with Compose and `openssl`.

Generate local secrets, create `.env`, and start Morsel:

```sh
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
MORSEL_API_KEY="$(openssl rand -hex 32)"
umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
MORSEL_API_KEY=$MORSEL_API_KEY
MORSEL_ENVIRONMENT=development
MORSEL_URL=http://localhost:12647/
MORSEL_PORT=12647
EOF
export MORSEL_API_KEY
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:12647/readyz
```

Open <http://localhost:12647/> to verify that the viewer is running.

The root [`compose.yaml`](compose.yaml) builds one Morsel image, waits for PostgreSQL, applies pending migrations, and starts the service as a non-root user. It binds Morsel to loopback by default. Keep the PostgreSQL password URL-safe because Compose interpolates it into a connection URL.

`.env` is ignored by Git and may contain runtime secrets. [`.env.example`](.env.example) contains no secrets.

Stop the services without deleting data:

```sh
docker compose down
```

Delete the local database only when data loss is intentional:

```sh
docker compose down --volumes
```

## Use the API

Create a share:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Hello\n\n$x^2$","expires_in":3600,"max_views":3,"preview":{"title":"Hello","description":"A Markdown share with an equation."}}' \
  http://127.0.0.1:12647/v1/shares
```

The response includes:

- `id`: the administrative UUID used to revoke the share
- `share_url`: the reader-facing URL containing the raw capability token
- `preview`: the normalized title and description exposed as non-consuming Open Graph metadata, omitted when disabled
- `telegram_instant_view`: whether the initial HTML exposes a server-rendered article for Telegram
- creation, expiration, and view-limit metadata

The raw capability appears only in `share_url`; Morsel stores its SHA-256 hash. Anyone with the URL can read the share and consume one view.

Omitting `preview` keeps the `#/s/<token>` URL.
Providing the object returns `/s/<token>` so Telegram can request server-rendered Open Graph metadata.
Both fields are required plain single-line text; surrounding whitespace is trimmed, the title is limited to 80 Unicode characters, and the description is limited to 200.
Boolean and null preview values are invalid.
Morsel stores and escapes these explicit values without deriving metadata from the Markdown. Open Graph metadata is consumed by Slack, Discord, Telegram, and other compatible link-preview crawlers.

To expose a share as a Telegram Instant View source page, explicitly opt in:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Article\n\nFull text.","preview":{"title":"Article","description":"Full text shared with Morsel."},"telegram_instant_view":true}' \
  http://127.0.0.1:12647/v1/shares
```

Instant View requires `preview` and cannot be combined with `expires_in` or `max_views`. It places safe, server-rendered GFM in the initial `/s/<token>` HTML without consuming a view. Authored HTML remains disabled; Mermaid and Vega-Lite blocks appear as source-code fallbacks. Install [`docs/telegram-instant-view-template.txt`](docs/telegram-instant-view-template.txt) for the deployment's domain in Telegram's Instant View Editor. Telegram template approval or publishing a deployment-specific `t.me/iv?...&rhash=...` link is an external step.

Enabling Instant View discloses the complete rendered article to Telegram and allows Telegram to cache it independently. Revocation removes it from future Morsel responses but cannot guarantee deletion of an existing Telegram copy.

Retrieve a share directly with the token after `/s/` or `#/s/`:

```sh
curl --fail-with-body \
  http://127.0.0.1:12647/v1/shares/RAW_CAPABILITY_TOKEN
```

Revoke a share with its administrative UUID:

```sh
curl --fail-with-body -X DELETE \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  http://127.0.0.1:12647/v1/shares/SHARE_UUID
```

See [`api/openapi.yaml`](api/openapi.yaml) for the complete contract. Public error responses contain stable `code` and `message` fields.

## How it works

```mermaid
flowchart LR
    Client[CLI / agent / internal app] -->|Bearer API key| Morsel[Go service]
    Reader[Reader] -->|viewer and same-origin API| Morsel
    Morsel --> DB[(PostgreSQL)]
    Morsel -->|capability share URL| Client
```

```mermaid
sequenceDiagram
    actor Creator as CLI / agent
    actor Reader
    participant Viewer as Browser / React viewer
    participant Morsel as Go service
    participant DB as PostgreSQL

    Creator->>Morsel: POST /v1/shares (Bearer API key)
    Morsel->>Morsel: Generate capability and SHA-256 hash
    Morsel->>DB: Store Markdown, capability hash, optional preview metadata, and Instant View opt-in
    DB-->>Morsel: Share metadata
    Morsel-->>Creator: 201 JSON with id and capability URL
    Creator-->>Reader: Send share URL
    Reader->>Viewer: Open share URL
    Viewer->>Morsel: GET / or /s/RAW_CAPABILITY_TOKEN
    Morsel-->>Viewer: React shell with optional Open Graph metadata
    Viewer->>Morsel: GET /v1/shares/RAW_CAPABILITY_TOKEN
    Morsel->>Morsel: Hash capability token
    Morsel->>DB: Conditional UPDATE ... RETURNING
    DB-->>Morsel: Markdown and incremented view count
    Morsel-->>Viewer: 200 share JSON (Cache-Control: no-store)
    Viewer->>Viewer: Sanitize and render Markdown
```

The service handles `/`, `/s/*`, `/assets/*`, `/v1/*`, `/healthz`, and `/readyz` on one domain. Preview-enabled `/s/<token>` responses inject Open Graph metadata into the otherwise static viewer shell. Instant View shares additionally inject server-rendered GFM into the viewer root; the React viewer replaces it after loading in a browser. JavaScript and CSS remain static assets. Morsel v1 has no Redis, object storage, queue, account system, separate static host, or Node.js runtime server.

### View and availability semantics

- Every successful `GET /v1/shares/<token>` consumes exactly one view, including browser refreshes, command-line requests, and bots that call the API.
- Fetching an enabled `/s/<token>` Open Graph preview does not consume a view. Link-preview crawlers do not execute the viewer JavaScript, while a browser does and therefore consumes a view through the API.
- An Instant View share exposes the complete rendered article through the same non-consuming request. It cannot use expiration or view limits, and revocation cannot remove copies already cached by Telegram.
- Preview metadata can be fetched repeatedly by anyone holding its capability URL. Disable preview when its explicit title or description must not be exposed this way.
- Morsel does not identify people or deduplicate clients. `max_views` counts successful retrievals, not unique readers.
- A conditional PostgreSQL `UPDATE ... RETURNING` protects the final view, so concurrent requests cannot exceed the configured limit.
- Retrieval responses use `Cache-Control: no-store`; proxies must not cache them.
- Unknown capabilities return `404`. Expired, revoked, and exhausted capabilities return `410` with distinct codes. This improves viewer messages but reveals the capability's state to anyone who already possesses it.
- A lost raw capability cannot be recovered. Revoke the share and create a replacement.

## Configuration

The API reads these environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MORSEL_DATABASE_URL` | yes | — | PostgreSQL connection URL. |
| `MORSEL_API_KEY` or `MORSEL_API_KEY_FILE` | yes | — | Comma-separated keys or a newline-delimited key file. Each key must contain at least 32 characters. Both sources may be combined during rotation. |
| `MORSEL_URL` | yes | — | Public origin used to construct hash-route or preview-enabled path links. Non-root paths, queries, fragments, and credentials are rejected. |
| `MORSEL_VIEWER_DIR` | no | `../viewer/dist` | Production viewer directory, relative to the usual `api/` working directory. The container uses `/srv/viewer`. |
| `MORSEL_ENVIRONMENT` | no | `development` | Set to `production` to require an HTTPS public URL. |
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

Startup rejects insecure public URLs, short API keys, empty viewer paths, and invalid limits or timeouts. Errors never echo configured secrets. Morsel does not enable cross-origin browser access; the bundled viewer calls the API on the same origin.

### Rotate API keys

1. Configure both the old and new keys, preferably with `MORSEL_API_KEY_FILE`.
2. Restart the API and move all administrative clients to the new key.
3. Remove the old key and restart again.

All configured keys are trusted administrators and may revoke any share.

## Production deployment

Set `MORSEL_ENVIRONMENT=production`, set `MORSEL_URL` to the public HTTPS origin—for example, `https://morsel.example.com/`—and route that domain to port 12647 through an HTTPS reverse proxy.

The reverse proxy must:

- preserve `X-Request-ID` response headers
- avoid logging authorization headers or raw `/s/<token>` paths
- never cache `/v1/shares/*` or `/s/*`

The Go server sends a Content Security Policy, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. Default hash routing keeps the capability out of the initial document request. Providing preview metadata intentionally uses a path capability so Telegram can fetch it; the Go request logger records this route as `unmatched` rather than logging the raw path.

### Backup, restore, and rollback

PostgreSQL is authoritative. Define recovery point and recovery time objectives appropriate to the deployment.

```sh
pg_dump --format=custom --dbname="$MORSEL_DATABASE_URL" --file=morsel.dump
createdb morsel_restored
pg_restore --clean --if-exists --no-owner \
  --dbname=morsel_restored morsel.dump
```

Back up before every schema change and test restores regularly. Roll back to a previous immutable image only when it supports the current schema; otherwise, roll forward with a corrective migration. Restore a database backup before accepting new writes, then reconcile shares created after the backup according to the recovery point objective.

The Morsel image contains both the API and viewer. Roll them back together; hash-route share URLs remain stable.

## Development

### Viewer

Requirements: Node.js 24.15 or newer in the 24.x line, or Node.js 26+; npm 11+. The development server proxies `/v1/*` requests to the Go API at `127.0.0.1:12647`.

```sh
cd viewer
npm ci
npm run dev
```

Run the full viewer checks:

```sh
cd viewer
npm run ci
npx playwright install chromium
npm run test:browser
```

Production has no separate viewer deployment or build-time API hostname. The root Docker build runs Vite, copies `viewer/dist` into the image, and lets the Go service serve both the viewer and API.

#### Mermaid diagram controls

Mermaid diagrams open fitted to the available space without upscaling. Use **Reset zoom** to restore a readable size, which may crop a large diagram, or **Fit to screen** to display the entire diagram. Pan by dragging or using the arrow keys. Zoom with the toolbar, `+`/`-`, or `Ctrl`/`Command` plus the mouse wheel. Press `0` to fit the diagram.

Fullscreen uses the browser API when available and an in-page fallback otherwise. Inline one-finger gestures continue scrolling the document. In fullscreen, one finger pans and two fingers pan and zoom. Escape closes fallback fullscreen and returns focus to the control that opened it.

The toolbar can show or copy source, copy or download sanitized SVG, and create a local PNG. PNG output is limited to 8,192 pixels per dimension and 16 million pixels. Export never calls an external rendering service. Diagrams rerender for light and dark appearances while retaining the last successful SVG if a theme refresh fails.

Diagrams near the viewport render on demand. Failed renders preserve their source and expose **Retry diagram**. Morsel allows up to 20 diagrams per document and 50 KiB of UTF-8 source per diagram. Rendering is sequential and uses Mermaid's `securityLevel: "strict"`, `htmlLabels: false`, and DOMPurify SVG sanitation.

#### Vega-Lite charts

Fenced `vega-lite` blocks containing JSON render as SVG charts near the viewport and rerender for light and dark appearances. Charts use the same fit, zoom, pan, fullscreen, source, copy, SVG export, and PNG export controls as Mermaid diagrams. Morsel allows up to 20 charts per document, 20 repeated views per chart, and 50 KiB of UTF-8 source per chart.

Chart data must be inline. The viewer disables Vega-Lite external data, image, and link resources, expansive data generators and transforms, authored embed options, tooltips, and action menus.

### Backend

Requirements: Go 1.26.6+, PostgreSQL 17, and Docker for integration tests.

```sh
cd api
go generate ./...
gofmt -w .
go vet ./...
go test ./...
```

Run the PostgreSQL integration and concurrency tests:

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

### Migrations

Migrations are embedded in the migration executable and protected by a PostgreSQL advisory lock.

```sh
cd api
MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction up
MORSEL_DATABASE_URL="$DATABASE_URL" go run ./cmd/migrate -direction down -steps 1
```

The runner rejects dirty, unknown, or gapped migration histories. Apply migrations before starting a newer API. Never automatically downgrade production.

## Security model

- Capability tokens contain 256 random bits, are base64url encoded, and are never stored raw.
- Preview is disabled when its metadata object is omitted. Hash-route URLs keep the capability out of the initial document request; preview metadata intentionally places it in `/s/<token>` so link crawlers can request the explicit title and description.
- Telegram Instant View is separately disabled by default. Enabling it exposes sanitized rendered Markdown in the initial HTML and permits Telegram to retain a cached copy outside Morsel's revocation controls.
- Administrative API keys are hashed before constant-time comparison.
- Request logs use route templates instead of token-bearing paths and omit bodies and authorization headers.
- Authored HTML is disabled. Markdown and KaTeX output pass through a reviewed sanitation schema.
- KaTeX trust is disabled. Mermaid renders sequentially with strict security, source and count limits, and DOMPurify SVG sanitation.
- Vega-Lite uses interpreted expressions, inline-only resources, rejected expansive generators and transforms, disabled embed options and tooltips, and source and count limits.
- External links use `noopener noreferrer`; images use `Referrer-Policy: no-referrer` and lazy loading.
- Production serves the API and viewer from one HTTPS origin and does not enable browser CORS.

Morsel cannot protect a share after its capability URL is disclosed. Revoke exposed shares and rotate exposed administrative keys.

## Repository layout

```text
api/          Go API, static-file serving, OpenAPI contract, and migrations
viewer/       React viewer source and build-time tests
docs/         Release validation and dependency review notes
.github/      GitHub Actions workflows for CI and deployment
Dockerfile    Production image build
compose.yaml  Local single-origin deployment
```

## License

Morsel is available under the [GNU Affero General Public License version 3](LICENSE) (`AGPL-3.0`).
