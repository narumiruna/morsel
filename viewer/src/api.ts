export interface Share {
  content: string
  created_at: string
  expires_at?: string | null
  max_views?: number | null
  view_count: number
  views_remaining?: number | null
}

export type ShareErrorCode =
  | "not_found"
  | "expired"
  | "revoked"
  | "view_limit_exhausted"
  | "invalid_request"
  | "internal_error"
  | "unknown"

export class ShareRequestError extends Error {
  constructor(
    public readonly code: ShareErrorCode,
    public readonly status: number,
  ) {
    super(code)
    this.name = "ShareRequestError"
  }
}

const requests = new Map<string, Promise<Share>>()

export function getShare(token: string): Promise<Share> {
  const existing = requests.get(token)
  if (existing) return existing
  const pending = fetch(`${__MORSEL_API_BASE_URL__}/v1/shares/${encodeURIComponent(token)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  }).then(async (response) => {
    if (!response.ok) {
      let code: ShareErrorCode = "unknown"
      try {
        const body = (await response.json()) as { code?: string }
        if (isShareErrorCode(body.code)) code = body.code
      } catch {
        // The status remains useful when a proxy returns a non-JSON error.
      }
      throw new ShareRequestError(code, response.status)
    }
    const body = (await response.json()) as Partial<Share>
    if (
      typeof body.content !== "string" ||
      typeof body.created_at !== "string" ||
      typeof body.view_count !== "number"
    ) {
      throw new ShareRequestError("unknown", response.status)
    }
    return body as Share
  })
  requests.set(token, pending)
  return pending
}

function isShareErrorCode(value: unknown): value is ShareErrorCode {
  return (
    typeof value === "string" &&
    [
      "not_found",
      "expired",
      "revoked",
      "view_limit_exhausted",
      "invalid_request",
      "internal_error",
    ].includes(value)
  )
}

export function clearRequestCacheForTests(): void {
  requests.clear()
}
