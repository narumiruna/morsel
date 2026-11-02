# Using Morsel

Start with the [Quick start](../README.md#quick-start). Create and revoke shares through REST with an owner-issued API key, or use [native MCP OAuth](#oauth-and-pi); readers need only the capability URL. `MORSEL_API_KEY` remains a client-side secret, not server configuration. Never expose it in browser code.

## Open a document

Paste a URL into **Document URL** on the homepage and select **Open document**. Validation runs locally; it does not spend a view. Opening a valid share then consumes one view through the normal reader. The input is not saved to browser storage.

Supported formats:

- A share URL from this Morsel origin, using `/s/<token>` or `/#/s/<token>`; relative forms also work.
- This origin's `/gist/#<id>` viewer URL.
- `https://gist.github.com/<id>` or `https://gist.github.com/<owner>/<id>`.

Other origins, credentials, query parameters, extra route segments, and unsupported fragments are rejected. Use the configured origin exactly, including a non-default development port. Fragment share URLs keep the capability out of the document request.

Select **View example** to open `/example`. The bundled example makes no share, Gist, or account request and needs no credentials.

## Account and client keys

1. Ask the operator to complete [initial setup](deployment.md#operator-setup-and-recovery). `/setup` creates the first `admin`. Later accounts use a one-use admin invitation link or a raw operator invitation token at `/invite`; all become `user`. Setup and recovery tokens belong only in forms, never URLs. Invitation links alone can carry a token in the fragment, never the query or path. Account display name and passkey name are separate; names need not be unique and never select ownership or a role.
2. Open `/login` at the configured origin and sign in with the intended account's passkey. `/account` shows that account's security settings and identity. Add a backup passkey; the last credential cannot be removed.
3. Open **API keys** at `/manage/api-keys`, complete fresh passkey verification if requested, and create a named API key. Copy it once into your client secret store. Only its SHA-256 hash and metadata are stored; the raw value cannot be recovered or listed later.
4. Export the UI-created value as `MORSEL_API_KEY` for existing scripts, curl examples, and the TypeScript client. Do not pass it to the Morsel server.

All active API keys in one account have the same share permissions. A key can create and revoke only that account's shares, including shares created with another key in the same account. The validated key determines ownership; request bodies, query parameters, and headers cannot select an owner. Foreign and missing share UUIDs return the same `404 not_found`. An admin's role permits invitation creation, not access to another account's shares. Use `/manage/api-keys` to list key metadata and confirm revocation after fresh verification. Key revocation stops subsequent requests, but does not cancel an already-authorized request or revoke shares. Revoke exposed shares separately. API keys cannot manage account credentials, sessions, other keys, browser-only share management, or invitations, even when the key belongs to an admin. Browser sessions cannot authorize the existing Bearer share-write routes; the separate account routes allow share inspection and revocation.

Sessions last 30 days from login and survive browser restarts; activity does not extend them. Sensitive changes reuse passkey verification for 12 hours. After deployment, log out and sign in again to use the longer session lifetime. Logout invalidates the server session and its pending OAuth consent, but not existing OAuth connections or API keys. If passkeys are lost, request operator recovery. Recovery targets one account UUID and invalidates that account's old passkeys, sessions, pending bound authentication grants, and OAuth codes/grant families/tokens through its authentication generation, but **does not revoke API keys** or affect other accounts. Shares keep their owner and recovery preserves the account role. Review and revoke suspect keys separately. Existing public share URLs do not require login. Anyone with a valid capability can read, including a user signed in to another account.

To switch accounts, log out, then select the intended passkey at `/login`. The UI shows account identity, refreshes it on focus and visibility restoration, and invalidates other tabs with secret-free `BroadcastChannel` events. Identity changes clear private state, saved links, one-time keys, and invitation links. Successful private browser responses carry a server-derived `X-Morsel-Account-ID`; missing or mismatched markers discard the response and refresh identity. Unauthenticated account state and errors need no marker. Bearer share writes and public capability reads do not use this browser identity marker. Mutations are not automatically replayed. This header is never an ownership selector.

## Connected apps

Open **Connected apps** under `/account` to inspect only your account's OAuth connections. Each row shows the unverified app name, client ID, connection ID, resource, scope, creation time, expiry, and revocation state. Names are not verified identities and need not be unique. Match IDs, not names, when two apps or accounts use the same name.

Select **Revoke**, inspect the connection, then **Confirm revoke app**. The server requires a browser session, exact configured Origin, session-bound CSRF, and passkey verification within twelve hours. Revocation stops that family's access and refresh tokens on subsequent requests. It does not cancel an already-authorized operation, revoke another connection, revoke API keys, or remove existing shares. Reconnect from the app to authorize a new family. **Retry connected apps** repeats only the list read, never a revocation.

API keys and OAuth tokens cannot list or revoke these browser-managed connections. Successful private responses use `Cache-Control: no-store` and `X-Morsel-Account-ID`; stale or mismatched responses are discarded, not replayed.

## Invite a new user

1. Sign in as an `admin` and open **Invitations** at `/manage/invitations`. The heading is **Manage invitations**. Users do not see this navigation entry and cannot use the section or its API. Roles are fixed; there is no role editor, user directory, or invitation that creates an admin.
2. Select **Create invitation link** and complete passkey verification if requested. The server requires a browser session, exact Origin, CSRF, and verification within twelve hours. It checks the current database role and inserts the grant in the same transaction. The response contains a configured-origin URL such as `https://morsel.narumi.dev/invite#token=<43-character base64url token>` and its expiry. It uses `Cache-Control: no-store` and the authorized `X-Morsel-Account-ID` marker. No owner or role input is accepted.
3. Use **Copy link**, or manually copy from the **Invitation link** textbox if clipboard access fails. Copy success is reported only after the clipboard operation completes. Send the link through a secure messaging channel. There is no SMTP, email binding, or person verification. Anyone who receives or is forwarded an unused link can register.
4. Keep a secure external copy if needed, then select **Dismiss invitation link** before creating another. Morsel shows each new link once and keeps it only in section memory, not browser storage. Leaving the section warns before discarding an undismissed link. Section exit, logout, identity change, or loss of admin permission clears it. Dismissal does not revoke it. Failed or uncertain requests are not replayed automatically; an explicit retry creates an independent invitation.

Each invitation lasts one hour and can be redeemed once. Issuing another does not cancel an earlier one. There is no invitation list or revocation in this phase. Links remain valid after the issuing admin logs out or recovers their account. Only the grant hash is stored in PostgreSQL; invitation creation adds no plaintext token storage.

Recipients open the link while signed out. The viewer reads exactly one bounded base64url token, rejects malformed or duplicate/unknown fragment fields, and immediately replaces the current history entry with clean `/invite`. It keeps the token only in invitation-flow memory and sends it in the existing registration POST body, never an HTTP URL. Opening the page or fetching a link preview alone does not consume the grant. Enter **Account name** and **Passkey name**, then explicitly select **Create account**. **Invitation token** still supports manual entry for operator tokens. No role choice is available.

A signed-in recipient must log out or use a private window, then reopen the original link. The viewer does not retain the invitation across logout or silently switch accounts. Both invitation begin and finish reject a valid signed-in session with `409 sign_out_required`, without consuming the grant or overwriting the session. Expired or invalid session cookies may proceed; database errors fail closed. Reloading or cancelling can require reopening the original link; cancellation does not consume it. Expired, used, invalid, or concurrently redeemed grants cannot create another account and use the generic invalid-grant response.

Fragment cleanup cannot erase copies already held by recipients, messaging previews, URL rewriting services, or browser history before cleanup. It prevents the viewer from restoring the secret through Back/Forward or storing it in navigation state, `next`, browser storage, or telemetry. Keep links out of logs and tickets. Real messaging behavior and physical passkey selection require separate deployment checks; virtual-browser tests do not prove them.

The browser issuance contract is `POST /v1/account/invitations` with `Content-Type: application/json`, body `{}`, and no query parameters. Success is `201 { "invitation_url": "<configured-origin fragment URL>", "expires_at": "<database timestamp>" }`. Users receive 403; API-key-only or signed-out clients receive 401. Rate limits return 429 with `Retry-After` and insert no grant. Existing Bearer share-write shapes and headers are unchanged.

## Manage existing shares in the WebUI

1. Open `/manage/shares` and sign in when requested. The requested section stays selected after login. Shares include only those owned by the signed-in account, including those created by any of its API keys. Migration 11 assigns legacy shares to the sole existing account. **API keys** and **Security** are separate sections; security settings do not require scrolling through shares.
2. Search displayed titles across your account's shares, select newest/oldest creation order or most/least views, or choose a status. On desktop, select the **Views** or **Created** column header to switch direction; the arrow shows the current order. The **Share order** selector supports all four orders on desktop and mobile. Changing order returns to page one and keeps the search and status filters. Search text, the submitted query, status, and order stay in memory when you switch between management sections; returning to Shares starts at page one. Logout, session loss, an account change, or a page reload clears these controls. Equal view counts use creation time, then UUID, in the same direction as the selected order. Search is a case-insensitive literal substring, not full-content search; `%`, `_`, and backslash are literal characters. Trimmed input is limited to 100 Unicode characters. Labels use an explicit plain preview title or the first meaningful Markdown line with formatting removed, bounded to 80 characters; empty labels become Untitled.
3. Select a share title to inspect the stored Markdown in a preview dialog. Select **Close** or press Escape to return to the selected row without losing your list position. Escape exits an expanded chart before closing the preview. Administrative inspection does not consume a view and works for revoked, expired, and exhausted shares. Images are shown as text placeholders, and Mermaid diagrams are shown as fenced source. Neither is loaded or executed during inspection: their image URLs can point to consuming share endpoints.
4. Scroll below the document inside the preview to see full metadata or **Copy share ID**. The compact list omits UUIDs and unconfigured limits. Dates use English and UTC. Matching count and current page describe a live result, not a frozen snapshot. **Refresh shares** updates the data and last-refreshed time.
5. Select **Copy link** to copy the saved public URL directly. **Link copied** appears only after clipboard success; no dialog opens. Select **More actions → Show link** to display the complete URL below the row actions. **Select link** selects the text for manual copying; **Hide link** or Escape in the URL field hides it. Clipboard failure also reveals this field. Neither action asks you to supply a URL or consumes a view. Browser copies stay only in section memory and are cleared when you leave Shares, reload, sign out, or change accounts; the server retains the original token for later retrieval. Copying does not reactivate revoked, expired, or exhausted shares.
6. Select **More actions → Revoke**, then confirm. Complete passkey verification if the previous verification is more than twelve hours old. Revocation cannot be undone. It does not delete stored content or remove external copies, including Telegram caches.

New API keys are shown once. Creation moves focus to the save-key panel and blocks another creation until you dismiss the displayed key. Copy and dismiss the key before leaving its section; in-app navigation warns before discarding an undismissed key. Revoking a key requires confirmation and stops integrations using it, without revoking their existing shares. The account menu contains logout. Passkey removal also requires confirmation. The last passkey cannot be removed; add a backup first.

If an API-key or passkey list fails to load, use its **Retry** button. Retry reads the list; it does not repeat a previous creation, revocation, or removal.

New shares retain their original capability tokens in PostgreSQL without encryption. Only an authenticated owner can retrieve saved links through the API; database or backup access also exposes these tokens. Older shares without retained plaintext tokens show **Link unavailable** instead of Copy link, and Show link is disabled. Their hashes cannot restore the URLs. This does not change existing public URLs or their availability. An administrative UUID is not a reader capability. Keep original URLs in secure records; see [share link storage](deployment.md#share-link-storage) for upgrade and backup requirements.

The browser-only routes are `GET /v1/account/shares`, `GET /v1/account/shares/{id}`, and `DELETE /v1/account/shares/{id}`. They require an owner session; API keys alone do not grant access. Mutations also require exact Origin, CSRF, and fresh verification. List and detail responses never return capability hashes or raw tokens; they include a `link_available` boolean. `GET /v1/account/shares/{id}/link` returns `{ "share_url": "<canonical public URL>" }` to the signed-in owner without consuming views, changing availability, or requiring fresh passkey verification. Owned legacy rows without retained tokens return `404 link_unavailable`; foreign and missing IDs return the same `404 not_found`. The response uses `Cache-Control: no-store`. The compatibility endpoint `POST /v1/account/shares/{id}/link` accepts `{ "token": "<original capability>" }` from the signed-in owner and returns `{ "share_url": "<canonical public URL>" }` only when its hash matches the row. It requires exact Origin and CSRF, but not fresh passkey verification. It does not retain the token, consume views, or change availability, and its response uses `Cache-Control: no-store`. The list omits full Markdown. Optional `q` and `sort=newest|oldest|most_views|least_views` parameters combine with status and cursor pagination; `matching_count` counts the account's complete filtered result before the cursor. Label readiness is also account-scoped. Version 3 cursors bind the account, search, status, and sort. View-sort cursors include the last row's view count; missing or invalid counts return 400. Old v1/v2 cursors and another account's cursors return 400. Reset to page one when changing a filter or sort, or when a cursor is unsupported. Counts and status can change between requests. With view sorting, a share can move across the cursor and be skipped or repeated; refresh from page one for the current order. A `503 label_backfill_required` response requires the operator to complete the [label backfill](deployment.md#share-management-rollout-and-review), not a client retry that ignores missing shares. See the [OpenAPI contract](../packages/server/openapi.yaml) for pagination and filters.

## Create a share

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Hello\n\n$x^2$","expires_in":3600,"max_views":3,"preview":{"title":"Hello","description":"A Markdown share with an equation.","image":"https://cdn.example/hello.png","locale":"en_US"}}' \
  http://127.0.0.1:12647/v1/shares
```

The response includes:

- `id`: the administrative UUID used to revoke the share
- `share_url`: the reader-facing URL containing the raw capability token
- `preview`: the normalized title, description, and optional image and locale exposed as non-consuming Open Graph metadata, omitted when disabled
- `telegram_instant_view`: whether the initial HTML exposes a server-rendered article for Telegram
- creation, expiration, and view-limit metadata

The raw capability appears only in `share_url`; Morsel stores its SHA-256 hash for public authorization and the plaintext token for owning-account retrieval. Anyone with an available URL can read the share and consume one view.

### Link previews

Omitting `preview` keeps the `#/s/<token>` URL. Providing the object returns `/s/<token>` so Telegram can request server-rendered Open Graph metadata. `title` and `description` are required plain single-line text; surrounding whitespace is trimmed, the title is limited to 80 Unicode characters, and the description is limited to 200. `image` and `locale` are optional. `image` must be an absolute HTTP(S) URL of at most 2048 characters without credentials; `locale` uses `language_TERRITORY` form such as `zh_TW`. Morsel always derives `og:url` from the configured public origin and capability path. Missing optional fields are not emitted.

Boolean and null preview values are invalid. Morsel stores and escapes these explicit values without deriving metadata from the Markdown. Open Graph metadata is consumed by Slack, Discord, Telegram, and other compatible link-preview crawlers. See [view and availability semantics](design.md#view-and-availability-semantics) for the privacy implications.

### Telegram Instant View

To expose a share as a Telegram Instant View source page, explicitly opt in:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Article\n\nFull text.","preview":{"title":"Article","description":"Full text shared with Morsel."},"telegram_instant_view":true}' \
  http://127.0.0.1:12647/v1/shares
```

Instant View requires `preview` and cannot be combined with `expires_in` or `max_views`. It places safe, server-rendered GFM in the initial `/s/<token>` HTML without consuming a view. Authored HTML remains disabled. The template uses the explicit preview image or falls back to the first Markdown image and marks right-to-left documents. Telegram cannot render Mermaid or Vega-Lite diagrams, so Instant View shows those fenced blocks as preformatted source instead. Install [`telegram-instant-view-template.txt`](telegram-instant-view-template.txt) for the deployment's domain in Telegram's Instant View Editor. Telegram template approval or publishing a deployment-specific `t.me/iv?...&rhash=...` link is an external step.

**Enabling Instant View discloses the complete rendered article to Telegram and allows Telegram to cache it independently.** Revocation removes it from future Morsel responses but cannot guarantee deletion of an existing Telegram copy.

## Retrieve and revoke

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

See the [OpenAPI contract](../packages/server/openapi.yaml) for the complete REST API. Public error responses contain stable `code` and `message` fields.

## MCP clients

Connect to `/mcp` with stateless Streamable HTTP. Normal responses are JSON; there are no persistent sessions, `Mcp-Session-Id` responses, or persistent SSE streams. Authenticated GET and DELETE return `405` with `Allow: POST`. The official Go MCP SDK is pinned to v1.8.0. Supported and tested protocol versions are `2025-11-25`, `2025-06-18`, and `2025-03-26`.

Every request, including `initialize` and `tools/list`, requires a Bearer OAuth access token or a UI-created API key. PostgreSQL validates the credential and account on every request; browser cookies alone cannot authorize MCP. OAuth is restricted to `/mcp`: its tokens cannot authorize REST `/v1/shares` writes, passkeys, invitations, keys, or connected-app management. Existing API keys retain their REST/MCP permissions and non-expiring lifetime until explicit revocation, including after account recovery. Never send credentials in chat or put them in browser code, URLs, or logs.

For POST requests, send `Content-Type: application/json` and `Accept: application/json, text/event-stream`, even though normal responses are JSON. After initialization, send `MCP-Protocol-Version` with the negotiated version. Use the public URL configured by `MORSEL_URL`: request authority/Host must match it after hostname-case and default-port normalization. An arbitrary backend bind hostname is not accepted. An omitted Origin is allowed; a supplied Origin must be exactly the canonical configured origin. Duplicate, `null`, and foreign Origins are forbidden. MCP CORS is not enabled. Only public OAuth metadata supports credential-free GET/OPTIONS CORS.

### OAuth and Pi

For a disposable local service configured with `MORSEL_URL=http://localhost:12647`, use this Pi project configuration:

```json
{
  "mcpServers": {
    "morsel": { "url": "http://localhost:12647/mcp" }
  }
}
```

Pi reads trusted project `.pi/mcp.json` and user `~/.pi/agent/mcp.json`. A full project entry replaces a same-name user entry. The repository example uses only the public URL; changing it does not change user-global settings. Remove an explicit `Authorization` header from the selected entry: it takes precedence and disables Pi OAuth. Do not configure `clientRegistration: "cimd"`; Morsel supports Dynamic Client Registration (DCR), not Client ID Metadata Documents (CIMD). CIMD is deliberately omitted despite the MCP recommendation, to avoid client-controlled metadata fetches and a new SSRF surface. Morsel does not fetch client URLs, logos, or callback targets.

1. In an approved client session, select **Sign in** for Morsel in `/mcp`, or run `/mcp login morsel`. The client discovers Morsel and registers a public native client with `token_endpoint_auth_method=none`; no client secret is issued.
2. Sign in with the intended Morsel account's passkey. The **Connect app** page shows the account name and UUID, unverified app name and client ID, redirect host, canonical resource, and permissions. A name or loopback callback does not prove who operates an app. Approve only a connection you started and trust.
3. Review `mcp:shares`: create account-owned shares, read any share for which the app holds a valid capability (one view per success), and revoke this account's shares. It grants no account-management or REST-write permission. `offline_access` adds rotating refresh tokens for persistent access, including after browser logout, for at most thirty days from approval. Pi's initial challenge requests both scopes so URL-only login can refresh without reopening the browser.
4. Select **Approve access**, with fresh passkey verification if required. **Deny access** requires the same session, exact Origin, and CSRF, but not fresh verification. Opening the page, GET requests, login alone, and previews never issue a grant or code.
5. Inspect or revoke the connection in [Connected apps](#connected-apps). Pi sign-out deletes its local credentials; use Morsel revocation to terminate the server-side connection.

Consent expires after ten minutes. Its first authenticated read binds the server-owned request handle to the displayed account and exact browser session. Account switching, logout, recovery, or even a new session for the same account requires restarting from the client. A stale page or duplicate submission cannot approve another account silently. The narrow `/oauth/consent?request=<opaque handle>` login destination is not an arbitrary `next` URL; do not put tokens or PKCE verifiers there.

Pi stores OAuth credentials in `~/.pi/agent/mcp-auth.json` by default, separate from `mcp.json`. Protect that file, private test profiles, backups, and process access. File storage is not proof of OS keyring integration. Do not commit tokens or copy them into chat. Native browser launching, physical passkeys, callback ownership, and native credential storage need the [external handoff](deployment.md#external-mcp-handoff). The last production probe returned `/mcp` HTTP 404; local discovery is not evidence that production is deployed or that an untested client is compatible.

### OAuth protocol and lifetimes

The issuer is the canonical `MORSEL_URL` origin; the sole resource is `<origin>/mcp`. They never come from Host or forwarded headers.

| Route | Contract |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` | Resource metadata and authorization-server discovery. |
| `GET /.well-known/oauth-authorization-server` | Issuer, endpoints, scopes, public-client authentication, `S256`, and RFC 9207 `iss` support. |
| `POST /oauth/register` | Bounded JSON native/public registration with name, redirects, and `token_endpoint_auth_method=none`. |
| `GET /oauth/authorize` | Authorization code request with client, redirect, `state`, scope, resource, and `S256` challenge; redirects only to the internal consent page after validation. |
| `POST /oauth/token` | Form-encoded code exchange or refresh; `client_id` and exact resource are required. Code exchange also requires the exact authorized redirect and verifier. Optional `scope` must match the grant after order normalization; narrowing or widening returns `invalid_scope`. |
| `POST /oauth/revoke` | Form-encoded `client_id`, token, and optional token-type hint; revokes that client's family and returns `{}` for unknown/foreign tokens too. |

Only exact registered redirects are accepted, except that an HTTP `127.0.0.1` or `[::1]` callback may change only its port. `localhost` and HTTPS redirects require exact matching. No wildcards, prefixes, credentials, fragments, query strings, or encoded paths are allowed. Error redirects are not sent before validation. Protocol fields are bounded and single-valued; unknown or duplicate fields are rejected. Only authorization code, `S256` PKCE, and refresh are supported; no implicit, password, client credentials, JWT, or client assertions are supported. Responses return `iss` and preserve bounded client `state`.

| State | Maximum lifetime |
| --- | --- |
| Pending authorization request | 10 minutes |
| One-use authorization code (`moc_`) | 1 minute |
| Access token (`moa_`) | 10 minutes, capped by family expiry |
| Family with `offline_access` and rotating refresh token (`mor_`) | 30 days absolute from approval, not sliding |
| Family without `offline_access` | 10 minutes from approval; no refresh token |

A refresh request normally omits `scope`, as Pi and the configured Go integration do. If supplied, it must match the granted canonical scope after order normalization: narrowing and widening both return `invalid_scope`. Downscoping is not implemented. To stop refresh capability, revoke the old connection and authorize a new request without `offline_access`.

The official Go MCP SDK v1.8.0 needs an explicit resource-aware refresh HTTP transport/`NewTokenSource` hook: its default `oauth2.Config.TokenSource` omits `resource` and receives HTTP 400. Keep the mandatory resource check; do not assume default SDK refresh works without that integration. Pi 1.4.0 sends resource on refresh.

Exchange and refresh are atomic. Rotation invalidates the old refresh and access credentials. Concurrent use or detected reuse of a consumed code/refresh token revokes the family, including its access tokens. If a code or refresh response is lost, the outcome is uncertain: do not automatically retry redemption. Restart authorization when the client cannot safely continue. Restarting the Go process does not reset registrations or grants; PostgreSQL persists them.

OAuth has finite admission and cleanup limits. Registrations expire after ninety days, extended by valid authorization/token traffic. All retained rows count toward limits: 10,000 clients, 10,000 requests, 10,000 grants, 100 grants per account, and 10,000 token rows per family. Revocation is not immediate deletion. Expired-row cleanup runs at most once per minute per process, with at most 2,000 rows per statement. Code/refresh replay tombstones remain for active families until family expiry; expired access rows can be pruned. Grant rows remain until family expiry. At a capacity limit, stop, allow eligible expiry/cleanup to free capacity, then explicitly reauthorize; do not add an automatic retry loop. See [operations](deployment.md#oauth-storage-and-admission-limits) for rate limits and correction paths.

### Custom-header configuration

This generic `mcpServers` JSON example is for a custom-header-capable HTTP client. Adapt it to the selected client's documented configuration format. It is not an external-client acceptance result. For local use, configure Morsel with `MORSEL_URL=http://localhost:12647`:

```json
{
  "mcpServers": {
    "morsel": {
      "type": "http",
      "url": "http://localhost:12647/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_YOUR_UI_CREATED_API_KEY"
      }
    }
  }
}
```

The uppercase value is a secret placeholder, not a working credential. Use the client's secret storage when available. Environment-variable and secret substitution syntax varies by client; this example does not assume interpolation. Protect any configuration file that holds the real key. For production, replace the URL with the approved configured HTTPS endpoint and complete the [external handoff](deployment.md#mcp-routing-and-external-handoff).

### Tools and results

`tools/list` publishes explicit MCP input and output schemas. OpenAPI covers REST and manual OAuth/account routes, not MCP tool schemas. Unknown fields, including owner selectors, are rejected.

| Tool | Arguments | Result and effect |
| --- | --- | --- |
| `create_share` | Required `content`; optional `expires_in`, `max_views`, `preview`, `telegram_instant_view`, as in REST | Creation metadata, including administrative `id` and secret `share_url`. Not idempotent. |
| `get_share` | `{ "token": "RAW_CAPABILITY_TOKEN" }`, not a URL or UUID | Markdown and view metadata. Every success consumes exactly one view and can exhaust the share; not read-only or idempotent. |
| `revoke_share` | `{ "id": "ADMINISTRATIVE_SHARE_UUID" }`, not a capability | `{ "id": "...", "revoked": true }`. Destructive; repeated revocation of an owned share succeeds. |

Creation uses the existing [preview and Instant View rules](#link-previews). `expires_in` is an integer from 1 to 315360000 seconds; `max_views` is an integer from 1 to 9223372036854775807. For these two optional fields, `null` means absent. `preview` must be an object with required `title` and `description`; boolean and null values are invalid. `telegram_instant_view` must be a boolean; when true, it requires preview without expiration or view limits. Existing document and request-body limits apply.

The validated access token or API key determines creation ownership and permits revocation only within its account. A foreign and a missing revocation UUID produce the same `not_found` tool error. Retrieval uses the capability, not ownership: a valid token can read another account's share without exposing the owner's identity. There are no account, list, or admin tools.

Tool results include `structuredContent` and the same JSON as text for clients without structured-result display. Share-operation and argument failures return `isError: true` with safe `code` and `message` fields. Expired, revoked, and exhausted capabilities retain distinct errors. Protocol failures use SDK JSON-RPC or HTTP validation errors; malformed and unregistered legacy requests can return HTTP `400`. Missing or invalid credentials return HTTP `401` with a Bearer challenge containing `resource_metadata` and `scope="mcp:shares offline_access"`. An otherwise valid access token without share permission returns HTTP `403` with `insufficient_scope`. Authentication database failures return safe HTTP `503` before tool execution, without falling back to another credential type. MCP tool errors are not REST HTTP status responses. Responses, including failures, use `Cache-Control: no-store`; existing time limits apply. If the request deadline ends before a response is committed, the server returns safe HTTP `504`.

Never retrieve a newly created share to validate its URL. Do not automatically retry `create_share` or `get_share`: an interrupted call can already have created a share or consumed a view. There is no exactly-once delivery guarantee.

### Local curl example

Use a disposable local database and `MORSEL_URL=http://localhost:12647`. Export your UI-created key as client-only `MORSEL_API_KEY` before running these commands; no key value is included below. Keep shell tracing off and do not log payloads or responses. Initialization and discovery do not consume views. The final command explicitly creates one fixture share; it does not retrieve it.

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $MORSEL_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"local-curl","version":"1.0"}}}' \
  http://localhost:12647/mcp

# Continue only after successful initialization with this negotiated version.
mcp_post() {
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer $MORSEL_API_KEY" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-11-25' \
    -d "$1" http://localhost:12647/mcp
}
mcp_post '{"jsonrpc":"2.0","method":"notifications/initialized"}'
mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Run only when you intend to create a share. Do not retry automatically.
mcp_post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_share","arguments":{"content":"# Local MCP fixture","max_views":1}}}'
```

Inspect JSON-RPC errors and `isError` as well as HTTP status. Keep the returned UUID and capability URL separate and secret. Do not call `get_share` unless retrieval is explicitly requested.

## TypeScript client

An independent, typed npm package lives in [`packages/client/`](../packages/client/README.md). It provides `createShare`, `consumeShare`, and `revokeShare` for the HTTP API. From the repository root, run `npm ci && npm run ci --workspace @narumitw/morsel-client` to build and test it. The package is not published automatically.

```ts
import { MorselClient } from "@narumitw/morsel-client"

// Run on your server; never expose MORSEL_API_KEY in browser code.
const client = new MorselClient({
  baseUrl: "https://morsel.narumi.dev",
  apiKey: process.env.MORSEL_API_KEY,
})
const { share_url } = await client.createShare({ content: "# Hello" })
```

Reading with `consumeShare(token)` does not need an API key, but every successful call consumes one view. See the [client instructions](../packages/client/README.md) for full usage and security notes.

## View a GitHub Gist

Put the GitHub Gist ID in the fragment after `/gist/#`:

```text
https://gist.github.com/narumiruna/7dbaf8170c7292354678069a9acb061f
https://morsel.narumi.dev/gist/#7dbaf8170c7292354678069a9acb061f
```

The fragment remains in the browser and is not sent to the Morsel server or intermediaries.

The static Morsel viewer requests the Gist directly from `api.github.com` and renders it with the same sanitized Markdown pipeline used for Morsel shares. Both public and secret Gists work when their ID is known; secret Gists are unlisted rather than private. No Morsel API key is required. Morsel does not proxy or store Gist content.

If a Gist contains multiple Markdown files, the viewer lists them in lexical filename order and provides a file selector. Files identified by GitHub as Markdown or named with `.md`, `.markdown`, `.mdown`, or `.mkd` are eligible. Gists without a Markdown file and Gists containing an eligible file whose content GitHub truncates are not rendered.

The browser sends no GitHub credentials, so GitHub's unauthenticated per-IP API rate limit applies separately to each reader.
