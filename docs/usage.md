# Using Morsel

Start with the [Quick start](../README.md#quick-start). Create and revoke shares with an administrative API key; readers need only the capability URL. Never expose `MORSEL_API_KEY` in browser code.

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
  baseUrl: "https://morsel.example.com",
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
