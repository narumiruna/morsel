# Use lowercase hex for new share tokens

**Status:** Dual-format readers implemented; hex issuance pending.

## Context and Problem Statement

At the start of this rollout, Morsel encodes 32 bytes of cryptographically secure randomness as a 43-character, unpadded Base64URL token. The token appears in `/#/s/<token>` by default or `/s/<token>` when link previews are enabled. We want new tokens to use a simpler alphabet without invalidating links that people already shared.

Morsel looks up a share by the SHA-256 hash of the **encoded token string**, not the decoded bytes. Re-encoding an existing token changes the lookup hash, even if the decoded bytes are identical. Some older shares have only a hash, so Morsel cannot recover their original tokens to re-encode them.

## Considered Options

1. **Keep Base64URL for new shares.** This keeps URLs shorter and needs no compatibility work, but new tokens continue to use a case-sensitive alphabet with `-` and `_`.
2. **Issue lowercase hex for new shares and keep reading Base64URL.** This limits new tokens to digits and lowercase `a`–`f` without breaking existing links. URLs grow by 21 characters, and readers must support both formats.
3. **Switch to hex only.** This leaves one format to validate, but invalidates existing links. Rewriting stored tokens would not update links already shared and is impossible for hash-only records.

## Decision Outcome

Choose option 2. Generate new share tokens from the same 32 random bytes and encode them as exactly 64 lowercase hex characters (`[0-9a-f]`). Accept both that format and the existing canonical, unpadded Base64URL format. Validate the token, then hash its original string without decoding it for lookup, re-encoding it, or changing its case.

Keep both URL forms unchanged. Do not rewrite or regenerate existing tokens or hashes. PostgreSQL already stores the retained token as text and the hash as 32 bytes, so no schema or data migration is required. This decision applies only to share tokens, not invitation or recovery tokens, API keys, or OAuth tokens.

### Consequences

- Token randomness stays at 256 bits. Hex changes how the token is written, not what access it grants. Clients should treat the token as an opaque string rather than assume a fixed length.
- Deploy a compatibility release that reads both formats but still issues Base64URL. Update the OpenAPI contract and the Telegram Instant View path rule for both formats. Start issuing hex only after the API and viewer can read both formats and the Telegram rule has been verified in the Instant View Editor.
- Once hex links are issued, rollback must retain support for reading them. The compatibility release can serve as a rollback target: it can resume issuing Base64URL without breaking hex links already shared. A Base64URL-only release cannot.

### Confirmation

- Verify that the generator produces 64 lowercase hex characters and that validation rejects malformed tokens without normalizing their spelling.
- Verify that a pre-existing Base64URL share and a new hex share open by direct URL and through homepage paste. Cover both fragment and path URLs, REST and MCP reads, and owner link retrieval and verification. Include a hash-only legacy row to confirm its original public URL still works.
- Verify that previews and Instant View work for both formats without consuming a view. Check both URL formats with the deployment's template in the Telegram Instant View Editor; repository tests alone cannot confirm Telegram behavior.

## More Information

- [Token generation and lookup hashing](../../packages/server/internal/share/token.go)
- [Share link storage](../deployment.md#share-link-storage)
- [Current Telegram Instant View template](../telegram-instant-view-template.txt)
