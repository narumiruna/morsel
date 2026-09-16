import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearRequestCacheForTests, getShare, ShareRequestError } from "./api"

const token = "A".repeat(43)

beforeEach(() => clearRequestCacheForTests())

describe("getShare", () => {
  it("caches one request per token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ content: "hello", created_at: "2026-01-01T00:00:00Z", view_count: 1 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const first = getShare(token)
    const second = getShare(token)
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ content: "hello" })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      `${__MORSEL_API_BASE_URL__}/v1/shares/${token}`,
      expect.objectContaining({ cache: "no-store", credentials: "omit" }),
    )
  })

  it("returns stable API error codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "expired" }), { status: 410 })),
    )
    await expect(getShare(token)).rejects.toEqual(new ShareRequestError("expired", 410))
  })

  it("handles malformed success and proxy errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gateway", { status: 502 })))
    await expect(getShare(token)).rejects.toEqual(new ShareRequestError("unknown", 502))
    clearRequestCacheForTests()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: 1 }), { status: 200 })),
    )
    await expect(getShare(token)).rejects.toEqual(new ShareRequestError("unknown", 200))
  })
})
