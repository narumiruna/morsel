# Deployment and configuration

For a local deployment, start with the [Quick start](../README.md#quick-start). The root [`compose.yaml`](../compose.yaml) builds one Morsel image, waits for PostgreSQL, applies pending migrations, and starts the service as a non-root user. It binds Morsel to loopback by default. Keep the PostgreSQL password URL-safe because Compose interpolates it into a connection URL. `.env` is ignored by Git and may contain runtime secrets; [`.env.example`](../.env.example) contains no secrets.

## Configuration

The API reads these environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MORSEL_DATABASE_URL` | yes | — | PostgreSQL connection URL. |
| `MORSEL_API_KEY` or `MORSEL_API_KEY_FILE` | yes | — | Comma-separated keys or a newline-delimited key file. Each key must contain at least 32 characters. Both sources may be combined during rotation. |
| `MORSEL_URL` | yes | — | Public origin used to construct hash-route or preview-enabled path links. Non-root paths, queries, fragments, and credentials are rejected. |
| `MORSEL_VIEWER_DIR` | no | `../packages/viewer/dist` | Production viewer directory, relative to the usual `api/` working directory. The container uses `/srv/viewer`. |
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

Startup rejects insecure public URLs, short API keys, empty viewer paths, and invalid limits or timeouts. Errors never echo configured secrets. Morsel does not enable cross-origin access to its API; the bundled viewer calls the share API on the same origin and only calls `api.github.com` directly for Gists.

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

The Morsel image contains both the API and viewer. Roll them back together; hash-route share URLs remain stable. See [migrations](development.md#migrations) for the migration runner.
