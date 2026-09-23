// Request and response names match the public OpenAPI contract in api/openapi.yaml.
export interface PreviewMetadata {
  title: string
  description: string
  image?: string
  locale?: string
}

export interface CreateShareRequest {
  content: string
  expires_in?: number
  max_views?: number
  preview?: PreviewMetadata
  telegram_instant_view?: boolean
}

export interface CreateShareResponse {
  id: string
  share_url: string
  created_at: string
  expires_at?: string | null
  max_views?: number | null
  preview?: PreviewMetadata
  telegram_instant_view: boolean
}

export interface Share {
  content: string
  created_at: string
  expires_at?: string | null
  max_views?: number | null
  view_count: number
  views_remaining?: number | null
}

export type MorselErrorCode =
  | "invalid_request"
  | "content_too_large"
  | "unauthorized"
  | "not_found"
  | "expired"
  | "revoked"
  | "view_limit_exhausted"
  | "internal_error"
  | "service_unavailable"
  | "unknown"

export class MorselApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: MorselErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "MorselApiError"
  }
}

export interface MorselClientOptions {
  /** The Morsel origin, e.g. https://morsel.example.com (no path, query or fragment). */
  baseUrl: string
  /** Keep this secret on the server. Required for createShare and revokeShare. */
  apiKey?: string
  /** Optional replacement for the platform fetch, useful for tests. */
  fetch?: typeof fetch
}

export interface RequestOptions {
  signal?: AbortSignal
}

/** No requests are cached or retried: each successful consumeShare costs one view. */
export class MorselClient {
  private readonly origin: string
  private readonly apiKey?: string
  private readonly fetcher: typeof fetch

  constructor(options: MorselClientOptions) {
    const url = new URL(options.baseUrl)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("baseUrl must be an HTTP(S) origin without credentials, path, query or fragment")
    }
    this.origin = url.origin
    this.apiKey = options.apiKey
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  async createShare(body: CreateShareRequest, options: RequestOptions = {}): Promise<CreateShareResponse> {
    const response = await this.fetcher(`${this.origin}/v1/shares`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.requireApiKey()}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
    return this.jsonResponse<CreateShareResponse>(response, 201)
  }

  async consumeShare(token: string, options: RequestOptions = {}): Promise<Share> {
    const response = await this.fetcher(`${this.origin}/v1/shares/${encodeURIComponent(token)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: options.signal,
    })
    return this.jsonResponse<Share>(response, 200)
  }

  async revokeShare(id: string, options: RequestOptions = {}): Promise<void> {
    const response = await this.fetcher(`${this.origin}/v1/shares/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.requireApiKey()}` },
      signal: options.signal,
    })
    if (response.status !== 204) throw await this.responseError(response)
  }

  private requireApiKey(): string {
    if (!this.apiKey) throw new TypeError("apiKey is required for createShare and revokeShare")
    return this.apiKey
  }

  private async jsonResponse<T>(response: Response, expectedStatus: number): Promise<T> {
    if (response.status !== expectedStatus) throw await this.responseError(response)
    try {
      return (await response.json()) as T
    } catch {
      throw new MorselApiError(response.status, "unknown", "Invalid JSON response")
    }
  }

  private async responseError(response: Response): Promise<MorselApiError> {
    try {
      const body: unknown = await response.json()
      if (typeof body === "object" && body !== null) {
        const { code, message } = body as Record<string, unknown>
        if (typeof code === "string" && typeof message === "string") {
          return new MorselApiError(response.status, isErrorCode(code) ? code : "unknown", message)
        }
      }
    } catch {
      // A proxy may return an empty or non-JSON error response.
    }
    return new MorselApiError(response.status, "unknown", `HTTP ${response.status}`)
  }
}

function isErrorCode(code: string): code is MorselErrorCode {
  return [
    "invalid_request", "content_too_large", "unauthorized", "not_found", "expired",
    "revoked", "view_limit_exhausted", "internal_error", "service_unavailable",
  ].includes(code)
}
