# Using Morsel

Start with the [Quick start](../README.md#quick-start). Create and revoke shares with an owner-issued API key; readers need only the capability URL. `MORSEL_API_KEY` remains a client-side secret, not server configuration. Never expose it in browser code.

## Open a document

Paste a URL into **Document URL** on the homepage and select **Open document**. Validation runs locally; it does not spend a view. Opening a valid share then consumes one view through the normal reader. The input is not saved to browser storage.

Supported formats:

- A share URL from this Morsel origin, using `/s/<token>` or `/#/s/<token>`; relative forms also work.
- This origin's `/gist/#<id>` viewer URL.
- `https://gist.github.com/<id>` or `https://gist.github.com/<owner>/<id>`.

Other origins, credentials, query parameters, extra route segments, and unsupported fragments are rejected. Use the configured origin exactly, including a non-default development port. Fragment share URLs keep the capability out of the document request.

Select **View example** to open `/example`. The bundled example makes no share, Gist, or account request and needs no credentials.

## Account and client keys

1. Ask the operator to complete [initial setup](deployment.md#operator-setup-and-recovery). Only the first account can register; invitations are not implemented.
2. Open `/account` at the configured origin (production: <https://morsel.narumi.dev/account>) and sign in with a passkey. Add a backup passkey; the last credential cannot be removed.
3. Open **API keys** at `/manage/api-keys`, complete fresh passkey verification if requested, and create a named API key. Copy it once into your client secret store. Only its SHA-256 hash and metadata are stored; the raw value cannot be recovered or listed later.
4. Export the UI-created value as `MORSEL_API_KEY` for existing scripts, curl examples, and the TypeScript client. Do not pass it to the Morsel server.

All owner-issued keys have administrator access and can revoke any share, including older shares. Use `/manage/api-keys` to list key metadata and confirm revocation after fresh verification. Key revocation stops subsequent requests, but does not cancel an already-authorized request or revoke shares. Revoke exposed shares separately. API keys cannot manage account credentials, sessions, other keys, or browser-only share management. Browser sessions cannot authorize the existing Bearer share-write routes; the separate account routes allow share inspection and revocation.

Sessions last 30 days from login and survive browser restarts; activity does not extend them. Sensitive changes reuse passkey verification for 12 hours. After deployment, log out and sign in again to use the longer session lifetime. Logout invalidates the server session. If passkeys are lost, request operator recovery. Recovery invalidates old credentials, sessions, and pending authentication grants, but **does not revoke API keys**. Review and revoke suspect keys separately. Existing public share URLs do not require login.

## Manage existing shares in the WebUI

1. Open `/manage/shares` and sign in when requested. The requested section stays selected after login. Shares include those created before account setup and with any API key. **API keys** and **Security** are separate sections; security settings do not require scrolling through shares.
2. Search displayed titles across all shares, select newest/oldest creation order or most/least views, or choose a status. On desktop, select the **Views** or **Created** column header to switch direction; the arrow shows the current order. The **Share order** selector supports all four orders on desktop and mobile. Changing order returns to page one and keeps the search and status filters. Equal view counts use creation time, then UUID, in the same direction as the selected order. Search is a case-insensitive literal substring, not full-content search; `%`, `_`, and backslash are literal characters. Trimmed input is limited to 100 Unicode characters. Labels use an explicit plain preview title or the first meaningful Markdown line with formatting removed, bounded to 80 characters; empty labels become Untitled.
3. Select **Preview** to inspect the stored Markdown. Administrative inspection does not consume a view and works for revoked, expired, and exhausted shares. Images are shown as text placeholders, and Mermaid diagrams are shown as fenced source. Neither is loaded or executed during inspection: their image URLs can point to consuming share endpoints.
4. Open details to see full metadata or **Copy share ID**. The compact list omits UUIDs and unconfigured limits. Dates use English and UTC. Matching count and current page describe a live result, not a frozen snapshot. **Refresh shares** updates the data and last-refreshed time.
5. Select **Revoke**, then confirm. Complete passkey verification if the previous verification is more than twelve hours old. Revocation cannot be undone. It does not delete stored content or remove external copies, including Telegram caches.

New API keys are shown once. Copy and dismiss the key before leaving its section; in-app navigation warns before discarding an undismissed key. Revoking a key requires confirmation and stops integrations using it, without revoking their existing shares. The account menu contains logout. The last passkey cannot be removed; add a backup first.

Morsel stores only the capability hash. The WebUI cannot recover or copy an original public URL. An administrative UUID is not a reader capability. Keep the original URL in your own records if you need it later.

The browser-only routes are `GET /v1/account/shares`, `GET /v1/account/shares/{id}`, and `DELETE /v1/account/shares/{id}`. They require an owner session; API keys alone do not grant access. Mutations also require exact Origin, CSRF, and fresh verification. These routes never return capability hashes or raw tokens. The list omits full Markdown. Optional `q` and `sort=newest|oldest|most_views|least_views` parameters combine with status and cursor pagination; `matching_count` counts the complete filtered result before the cursor. Cursors are bound to search, status, and sort. View-sort cursors include the last row's view count; missing or invalid counts return 400. Existing v2 creation cursors remain valid; old v1 cursors remain valid for an empty search with newest-first order. Reset to page one when changing a filter or sort, or when a cursor is unsupported. Counts and status can change between requests. With view sorting, a share can move across the cursor and be skipped or repeated; refresh from page one for the current order. A `503 label_backfill_required` response requires the operator to complete the [label backfill](deployment.md#share-management-rollout-and-review), not a client retry that ignores missing shares. See the [OpenAPI contract](../api/openapi.yaml) for pagination and filters.

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

The raw capability appears only in `share_url`; Morsel stores its SHA-256 hash. Anyone with the URL can read the share and consume one view.

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

See the [OpenAPI contract](../api/openapi.yaml) for the complete API. Public error responses contain stable `code` and `message` fields.

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
