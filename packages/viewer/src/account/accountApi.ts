import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser"

export type Account = {
  setup_required: boolean
  authenticated: boolean
  account_id?: string
  display_name?: string
  role?: "admin" | "user"
  csrf_token?: string
  verification_required?: boolean
}

export type Passkey = { id: string; name: string; created_at: string }
export type APIKey = Passkey & { prefix: string; revoked_at: string | null }
export type AuthOperation = "setup" | "invite" | "login" | "recover" | "verify" | "passkey"

export type ExpectedAccount = {
  id: string
  isCurrent: () => boolean
  invalidate: () => void
}

// No identity, token, or private data is sent to other tabs.
export const accountChannel = "morsel:account-invalidation"
export function broadcastAccountChange() {
  window.dispatchEvent(new Event(accountChannel))
}

export function checkAccount(expected: ExpectedAccount, marker = expected.id) {
  if (marker === expected.id && expected.isCurrent()) return
  expected.invalidate()
  throw new AccountError(
    409,
    "account_changed",
    "The account changed. Review the current account and try again.",
  )
}

export class AccountError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function accountRequest<T>(
  path: string,
  {
    method = "GET",
    body,
    csrf,
    signal,
    expectedAccount,
  }: {
    method?: "GET" | "POST" | "DELETE"
    body?: unknown
    csrf?: string
    signal?: AbortSignal
    expectedAccount?: ExpectedAccount
  } = {},
): Promise<T> {
  signal?.throwIfAborted()
  if (expectedAccount) checkAccount(expectedAccount)
  const headers: Record<string, string> = { Accept: "application/json" }
  if (method !== "GET") headers["Content-Type"] = "application/json"
  if (csrf) headers["X-CSRF-Token"] = csrf
  const response = await fetch(`/v1/${path}`, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  signal?.throwIfAborted()
  const check = () => {
    signal?.throwIfAborted()
    if (expectedAccount) {
      // Errors can occur before authorization. Success must always identify its authorized account.
      const marker = response.headers.get("X-Morsel-Account-ID")
      checkAccount(expectedAccount, marker ?? (response.ok ? "" : expectedAccount.id))
    }
  }
  check()
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    check()
    const error = body && typeof body === "object" ? body : {}
    throw new AccountError(
      response.status,
      "code" in error && typeof error.code === "string" ? error.code : "request_failed",
      "message" in error && typeof error.message === "string"
        ? error.message
        : "The request failed. Try again.",
    )
  }
  if (response.status === 204) return undefined as T
  const result: unknown = await response.json()
  check()
  if (path === "account") {
    const account = result as Account
    if (
      account.authenticated &&
      (!account.account_id ||
        !account.display_name ||
        response.headers.get("X-Morsel-Account-ID") !== account.account_id)
    )
      throw new AccountError(
        409,
        "account_changed",
        "Could not verify the account identity. Try again.",
      )
  }
  return result as T
}

export function supportsPasskeys(): boolean {
  return browserSupportsWebAuthn()
}

export async function authenticate(
  operation: AuthOperation,
  body: { token?: string; name?: string; display_name?: string },
  csrf?: string,
  signal?: AbortSignal,
  expectedAccount?: ExpectedAccount,
): Promise<void> {
  if (!supportsPasskeys()) throw new Error("This browser does not support passkeys.")
  const path = `auth/${operation}`
  const options = { method: "POST" as const, csrf, signal, expectedAccount }
  const prompt = async <T>(start: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted()
    const cancel = () => WebAuthnAbortService.cancelCeremony()
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      return await start()
    } finally {
      signal?.removeEventListener("abort", cancel)
    }
  }
  let credential: unknown
  if (operation === "login" || operation === "verify") {
    const response = await accountRequest<{
      publicKey: PublicKeyCredentialRequestOptionsJSON
    }>(`${path}/begin`, { ...options, body })
    credential = await prompt(() => startAuthentication({ optionsJSON: response.publicKey }))
  } else {
    const response = await accountRequest<{
      publicKey: PublicKeyCredentialCreationOptionsJSON
    }>(`${path}/begin`, { ...options, body })
    credential = await prompt(() => startRegistration({ optionsJSON: response.publicKey }))
  }
  // A page that was left during the browser prompt must not complete the flow.
  signal?.throwIfAborted()
  await accountRequest(`${path}/finish`, { ...options, body: credential })
  if (["login", "setup", "invite", "recover"].includes(operation)) broadcastAccountChange()
}

export function accountErrorMessage(error: unknown): string {
  if (error instanceof AccountError) {
    if (error.status === 401) return "Your session expired. Sign in again."
    if (error.status === 403) return "Authorization expired. Try again to verify your passkey."
    return error.message
  }
  if (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "NotAllowedError"
  ) {
    return "The passkey request was cancelled or timed out. Try again."
  }
  if (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "InvalidStateError"
  ) {
    return "This passkey is already registered. Use a different passkey."
  }
  return "The request could not be completed. Check your connection and try again."
}
