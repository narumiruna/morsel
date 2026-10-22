export type ShareStatus = "active" | "revoked" | "expired" | "view_limit_exhausted"

export interface ManagedShare {
  id: string
  title: string
  excerpt: string
  created_at: string
  expires_at?: string | null
  max_views?: number | null
  view_count: number
  revoked_at?: string | null
  status: ShareStatus
}

export interface ShareList {
  items: ManagedShare[]
  next_offset?: number
}

export class ManagementError extends Error {
  constructor(public readonly status: number) {
    super("Management request failed")
    this.name = "ManagementError"
  }
}

async function request(key: string, path: string, method: string, signal?: AbortSignal) {
  const response = await fetch(path, {
    method,
    headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  })
  if (!response.ok) throw new ManagementError(response.status)
  return response
}

export async function listShares(
  key: string,
  offset: number,
  signal?: AbortSignal,
): Promise<ShareList> {
  const response = await request(key, `/v1/shares?limit=50&offset=${offset}`, "GET", signal)
  return response.json()
}

export async function revokeShare(key: string, id: string, signal?: AbortSignal): Promise<void> {
  await request(key, `/v1/shares/${encodeURIComponent(id)}`, "DELETE", signal)
}
