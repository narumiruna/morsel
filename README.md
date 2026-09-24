# Morsel

Morsel is a small, self-hosted service for sharing Markdown through revocable capability URLs. One Go service exposes the API and serves the React viewer from the same origin; PostgreSQL is the only content store.

- Create and revoke shares through an API, with optional expiration and view limits.
- Render GitHub Flavored Markdown with syntax highlighting, KaTeX, Mermaid, and Vega-Lite charts.
- View Markdown files from GitHub Gists without storing them in Morsel.
- Opt in to Open Graph previews or Telegram Instant View articles.
- Use a sanitized viewer with light, dark, Sepia, Sage, and Midnight themes.

## Quick start

Requirements: Docker with Compose and `openssl`.

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

Open <http://localhost:12647/> to check the viewer. The root [`compose.yaml`](compose.yaml) starts Morsel and PostgreSQL, applies migrations, and binds the service to loopback by default. `.env` is ignored by Git; [`.env.example`](.env.example) contains no secrets. Keep the PostgreSQL password URL-safe because Compose interpolates it into a connection URL.

Stop without deleting data with `docker compose down`. **`docker compose down --volumes` deletes the local database.** For public deployment, see [deployment and configuration](docs/deployment.md).

## Create a share

With `MORSEL_API_KEY` exported in your shell:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Hello\n\n$x^2$","expires_in":3600,"max_views":3}' \
  http://127.0.0.1:12647/v1/shares
```

The response contains a reader-facing `share_url` and an administrative `id` for revocation. **Anyone with the URL can read the share; every successful retrieval consumes a view.** See [using Morsel](docs/usage.md) for retrieval, revocation, previews, Instant View, Gists, and the TypeScript client. The [OpenAPI contract](api/openapi.yaml) specifies all endpoints.

## Documentation

- [Using Morsel](docs/usage.md): shares, previews, Telegram Instant View, Gists, and the client.
- [Deployment and configuration](docs/deployment.md): environment variables, key rotation, production, backups, and rollback.
- [Design and security](docs/design.md): architecture, view semantics, and the security model.
- [Viewer features](docs/viewer.md): Mermaid and Vega-Lite controls and limits.
- [Development](docs/development.md): setup, tests, and migrations.
- [TypeScript client](packages/client/README.md) · [OpenAPI contract](api/openapi.yaml)

## License

Morsel is available under the [GNU Affero General Public License version 3](LICENSE) (`AGPL-3.0`).
