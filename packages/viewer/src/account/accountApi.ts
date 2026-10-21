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
  csrf_token?: string
}

export type Passkey = { id: string; name: string; created_at: string }
export type APIKey = Passkey & { prefix: string; revoked_at: string | null }
export type AuthOperation = "setup" | "login" | "recover" | "verify" | "passkey"

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
  }: {
    method?: "GET" | "POST" | "DELETE"
    body?: unknown
    csrf?: string
    signal?: AbortSignal
  } = {},
): Promise<T> {
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
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
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
  return response.json() as Promise<T>
}

export function supportsPasskeys(): boolean {
  return browserSupportsWebAuthn()
}

export async function authenticate(
  operation: AuthOperation,
  body: { token?: string; name?: string },
  csrf?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!supportsPasskeys()) throw new Error("This browser does not support passkeys.")
  const path = `auth/${operation}`
  const options = { method: "POST" as const, csrf, signal }
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
