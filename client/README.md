# Morsel TypeScript client

Typed client for the [Morsel share API](https://github.com/narumiruna/morsel/blob/main/api/openapi.yaml). Requires Node.js 20+ (or a runtime with `fetch`). The package has no runtime dependencies.

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

To consume a share, pass the 43-character capability token (from the URL after `/s/` or `#/s/`) to `consumeShare(token)`. No API key is needed for reading. **Every successful call consumes one view**; the client never caches or retries a request. Each method accepts an optional `{ signal }` for cancellation.

The package lives in `client/` and is not published automatically. From that directory, run `npm ci && npm run ci` and inspect `npm pack --dry-run` before publishing. The request and response types follow the [OpenAPI contract](https://github.com/narumiruna/morsel/blob/main/api/openapi.yaml).
