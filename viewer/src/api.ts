export interface Share {
  content: string
  created_at: string
  expires_at?: string | null
  max_views?: number | null
  view_count: number
  views_remaining?: number | null
}

export interface GistDocument {
  filename: string
  content: string
}

interface GitHubGistFile {
  filename?: unknown
  language?: unknown
  content?: unknown
  truncated?: unknown
}

export type ShareErrorCode =
  | "not_found"
  | "expired"
  | "revoked"
  | "view_limit_exhausted"
  | "invalid_request"
  | "internal_error"
  | "unknown"

export type GistErrorCode = "not_found" | "content_too_large" | "service_unavailable" | "unknown"

export class ShareRequestError extends Error {
  constructor(
    public readonly code: ShareErrorCode,
    public readonly status: number,
  ) {
    super(code)
    this.name = "ShareRequestError"
  }
}

export class GistRequestError extends Error {
  constructor(
    public readonly code: GistErrorCode,
    public readonly status: number,
  ) {
    super(code)
    this.name = "GistRequestError"
  }
}

const requests = new Map<string, Promise<Share>>()
const gistRequests = new Map<string, Promise<GistDocument>>()

export function getShare(token: string): Promise<Share> {
  const existing = requests.get(token)
  if (existing) return existing
  const pending = fetch(`/v1/shares/${encodeURIComponent(token)}`, {
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
  void pending.catch(() => {
    if (requests.get(token) === pending) requests.delete(token)
  })
  return pending
}

export function getGist(id: string): Promise<GistDocument> {
  const existing = gistRequests.get(id)
  if (existing) return existing
  const pending = fetch(`https://api.github.com/gists/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  }).then(async (response) => {
    if (!response.ok) {
      const code: GistErrorCode =
        response.status === 404
          ? "not_found"
          : response.status === 403 || response.status === 429
            ? "service_unavailable"
            : "unknown"
      throw new GistRequestError(code, response.status)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new GistRequestError("unknown", response.status)
    }
    return selectMarkdownFile(body, response.status)
  })
  gistRequests.set(id, pending)
  void pending.catch(() => {
    if (gistRequests.get(id) === pending) gistRequests.delete(id)
  })
  return pending
}

function selectMarkdownFile(body: unknown, status: number): GistDocument {
  if (!isObject(body) || !isObject(body.files)) {
    throw new GistRequestError("unknown", status)
  }
  const candidates = Object.entries(body.files)
    .filter((entry): entry is [string, GitHubGistFile] => {
      const [key, file] = entry
      return isObject(file) && isMarkdown(key, file.filename, file.language)
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const selected = candidates[0]
  if (!selected) {
    throw new GistRequestError("not_found", status)
  }
  const [key, file] = selected
  if (file.truncated === true) {
    throw new GistRequestError("content_too_large", status)
  }
  if (typeof file.content !== "string") {
    throw new GistRequestError("unknown", status)
  }
  return {
    filename: typeof file.filename === "string" && file.filename !== "" ? file.filename : key,
    content: file.content,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMarkdown(...values: unknown[]): boolean {
  return values.some(
    (value) =>
      typeof value === "string" &&
      (value.toLowerCase() === "markdown" || /\.(?:md|markdown|mdown|mkd)$/i.test(value)),
  )
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
  gistRequests.clear()
}
