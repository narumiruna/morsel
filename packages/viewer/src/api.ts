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
const gistRequests = new Map<string, Promise<GistDocument[]>>()

// Keep successful reads for this page lifetime; consuming a share again spends another view.
function cachedRequest<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key)
  if (existing) return existing
  const pending = load()
  cache.set(key, pending)
  void pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key)
  })
  return pending
}

export function getShare(token: string): Promise<Share> {
  return cachedRequest(requests, token, () =>
    fetch(`/v1/shares/${encodeURIComponent(token)}`, {
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
    }),
  )
}

export function getGist(id: string): Promise<GistDocument[]> {
  return cachedRequest(gistRequests, id, () =>
    fetch(`https://api.github.com/gists/${encodeURIComponent(id)}`, {
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
      return selectMarkdownFiles(body, response.status)
    }),
  )
}

function selectMarkdownFiles(body: unknown, status: number): GistDocument[] {
  if (!isObject(body) || !isObject(body.files)) {
    throw new GistRequestError("unknown", status)
  }
  const candidates = Object.entries(body.files).filter(
    (entry): entry is [string, GitHubGistFile] => {
      const [key, file] = entry
      return isObject(file) && isMarkdown(key, file.filename, file.language)
    },
  )
  if (candidates.length === 0) {
    throw new GistRequestError("not_found", status)
  }
  return candidates
    .map(([key, file]) => {
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
    })
    .sort(({ filename: left }, { filename: right }) => (left < right ? -1 : left > right ? 1 : 0))
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
