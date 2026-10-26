# Morsel

Morsel is a small, self-hosted service for sharing Markdown through revocable capability URLs. One Go service exposes the API and serves the React viewer from the same origin; PostgreSQL is the only content store.

- Open a share or GitHub Gist URL from the homepage, or try the bundled example.
- Sign in with a passkey to search your account's shares in `/manage/shares`, manage client keys in `/manage/api-keys`, and manage security in `/account`.
- As an admin, create one-use account invitation links in `/manage/invitations` and send them manually.
- Create and revoke shares through an API, with optional expiration and view limits.
- Render GitHub Flavored Markdown with syntax highlighting, KaTeX, Mermaid, and Vega-Lite charts.
- View Markdown files from GitHub Gists without storing them in Morsel.
- Opt in to Open Graph previews or Telegram Instant View articles.
- Use a sanitized viewer with light, dark, Sepia, Sage, and Midnight themes.

## Quick start

Requirements: Docker with Compose and `openssl`. These steps are for a fresh database. For an existing deployment, use the [maintenance upgrade](docs/deployment.md#multi-account-maintenance-upgrade) instead.

```sh
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
MORSEL_ENVIRONMENT=development
MORSEL_URL=http://localhost:12647/
MORSEL_PORT=12647
EOF
export MORSEL_IMAGE=morsel:local
docker build --tag "$MORSEL_IMAGE" .
docker compose up --detach --wait --wait-timeout 120
docker compose ps
curl --fail http://127.0.0.1:12647/readyz
```

Create a one-use operator token after the services and migrations are ready:

```sh
docker compose run --rm --no-deps --entrypoint /usr/local/bin/account morsel -kind setup
```

Open <http://localhost:12647/setup>, enter the token in the setup form within one hour, and enroll the first account's passkey. Setup creates an `admin`. Admins use **Invitations** to create a one-hour, one-use link and send it manually; the operator CLI can still issue raw invitation tokens. Every invitation creates a `user`; recipients cannot select a role. Neither role can manage another account's shares. Account display names need not be unique. Add a backup passkey, then open **API keys** and create a client key. Copy the key when shown; it cannot be recovered. Export it as the **client-only** secret `MORSEL_API_KEY` for the examples below. Privileged share operations are rejected until setup; public share reads are unchanged.

New shares retain their original tokens in PostgreSQL so the signed-in account can copy or show its own saved links. No share-link encryption key is required. Database access or a backup exposes these tokens and their share URLs; protect both as secrets. See [share link storage](docs/deployment.md#share-link-storage) before upgrading an existing deployment.

The root [`compose.yaml`](compose.yaml) uses the explicitly built image, starts PostgreSQL, applies migrations, and binds Morsel to loopback. Keep `MORSEL_IMAGE=morsel:local` exported for later Compose commands. `.env` is ignored by Git; [`.env.example`](.env.example) contains no secrets. Keep the PostgreSQL password URL-safe because Compose interpolates it into a connection URL.

Stop without deleting data with `docker compose down`. **`docker compose down --volumes` deletes the local database.** For public deployment or an existing database, see [deployment and configuration](docs/deployment.md#multi-account-maintenance-upgrade). Migrations 11 and 12 require a maintenance window with all old instances stopped. Migration 12 makes the oldest existing account (`created_at, id`) the admin and the rest users; verify that UUID on a restored production copy first. Implementation validation authorizes no production release.

## Create a share

With the UI-created API key exported as `MORSEL_API_KEY` in your client shell (never as server configuration):

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Hello\n\n$x^2$","expires_in":3600,"max_views":3}' \
  http://127.0.0.1:12647/v1/shares
```

The response contains a reader-facing `share_url` and an administrative `id` for revocation. **Anyone with the URL can read the share; every successful retrieval consumes a view.** See [using Morsel](docs/usage.md) for retrieval, revocation, previews, Instant View, Gists, and the TypeScript client. The [OpenAPI contract](packages/server/openapi.yaml) specifies all endpoints.

## Documentation

- [Using Morsel](docs/usage.md): shares, previews, Telegram Instant View, Gists, and the client.
- [Deployment and configuration](docs/deployment.md): environment variables, key rotation, production, backups, and rollback.
- [Design and security](docs/design.md): architecture, view semantics, and the security model.
- [Viewer features](docs/viewer.md): Mermaid and Vega-Lite controls and limits.
- [Development](docs/development.md): setup, tests, and migrations.
- [TypeScript client](packages/client/README.md) · [OpenAPI contract](packages/server/openapi.yaml)

## License

Morsel is available under the [GNU Affero General Public License version 3](LICENSE) (`AGPL-3.0`).
