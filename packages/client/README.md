# Morsel TypeScript client

Typed client for the [Morsel share API](https://github.com/narumiruna/morsel/blob/main/packages/server/openapi.yaml). Requires Node.js 20+ (or a runtime with `fetch`). The package has no runtime dependencies.

Install after publishing:

```sh
npm install @narumitw/morsel-client
```

Create and revoke shares **only on a trusted server**. Never ship `MORSEL_API_KEY` to a browser or bundle it into frontend code. Morsel does not enable cross-origin CORS for browser requests.

```ts
import { MorselApiError, MorselClient } from "@narumitw/morsel-client"

const morsel = new MorselClient({
  baseUrl: "https://morsel.example.com",
  apiKey: process.env.MORSEL_API_KEY,
})

try {
  const share = await morsel.createShare({
    content: "# Hello, world!",
    expires_in: 3600,
    max_views: 3,
  })
  console.log(share.share_url) // give this URL to readers
  await morsel.revokeShare(share.id) // administrative UUID, not the capability token
} catch (error) {
  if (error instanceof MorselApiError) {
    console.error(error.status, error.code, error.message)
  } else {
    throw error // network or configuration error
  }
}
```

Share ownership comes from the validated API key, not a request argument. All active keys in the same account can create and revoke that account's shares. Revocation of a foreign or missing share UUID returns the same `404 not_found`. Account recovery and key rotation do not change ownership. No account selector is needed in this client or the Markdown CLI. The `admin` and `user` roles do not grant cross-account share access. An admin-owned API key cannot issue invitations; invitation creation requires an admin browser session with Origin, CSRF, and fresh passkey verification at `POST /v1/account/invitations`. This share client has no invitation or role-management method. Bearer request/response shapes and headers are unchanged; the browser-only `X-Morsel-Account-ID` marker is not added to share writes.

To consume a share, pass the 43-character capability token (from the URL after `/s/` or `#/s/`) to `consumeShare(token)`. No API key is needed for reading. Anyone with a valid capability can read, including someone signed in to a different account. **Every successful call consumes one view**; the client never caches or retries a request. Each method accepts an optional `{ signal }` for cancellation.

The package lives in `packages/client/` and is not published automatically. From the repository root, run `npm ci && npm run ci --workspace @narumitw/morsel-client` and inspect `npm pack --workspace @narumitw/morsel-client --dry-run` before publishing. The request and response types follow the [OpenAPI contract](https://github.com/narumiruna/morsel/blob/main/packages/server/openapi.yaml).
