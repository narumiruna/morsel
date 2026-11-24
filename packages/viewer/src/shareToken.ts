export function isShareToken(token: string): boolean {
  // A 32-byte Base64URL token has four data bits in its final character.
  return /^(?:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]|[0-9a-f]{64})$/.test(token)
}
