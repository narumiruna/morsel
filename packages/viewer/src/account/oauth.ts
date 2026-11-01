export type OAuthRequest = {
  client_id: string
  client_name: string
  redirect_host: string
  resource: string
  scope: "mcp:shares" | "mcp:shares offline_access"
  expires_at: string
  account_id: string
}

export type OAuthGrant = {
  id: string
  client_id: string
  client_name: string
  resource: string
  scope: string
  created_at: string
  expires_at: string
  revoked_at: string | null
}

export const invalidOAuthRequest =
  "This connection request is no longer valid. Restart the connection from your app."

// A 32-byte, unpadded base64url handle has exactly these canonical final characters.
export function consentRequestHandle(search: string): string | null {
  const match = /^\?request=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/.exec(search)
  return match?.[0] === search ? (match[1] ?? null) : null
}

export function isConsentDestination(destination: string): boolean {
  const path = "/oauth/consent"
  return (
    destination.startsWith(path) && consentRequestHandle(destination.slice(path.length)) !== null
  )
}

// The server validates the registered callback. This check also rejects unsafe URL schemes.
export function isOAuthCallback(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    /\s/.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false
  try {
    const url = new URL(value)
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
    )
  } catch {
    return false
  }
}
