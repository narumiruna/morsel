import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearRequestCacheForTests,
  GistRequestError,
  getGist,
  getShare,
  ShareRequestError,
} from "./api"

const token = "A".repeat(43)

beforeEach(() => clearRequestCacheForTests())

describe("getGist", () => {
  it("fetches GitHub directly, caches the request, and returns every Markdown file", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          files: {
            "notes.txt": { filename: "notes.txt", language: "Text", content: "ignore" },
            "z.md": { filename: "z.md", language: "Markdown", content: "# Z" },
            "a.markdown": { filename: "a.markdown", language: "Markdown", content: "# A" },
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const first = getGist("abc123")
    expect(getGist("abc123")).toBe(first)
    await expect(first).resolves.toEqual([
      { filename: "a.markdown", content: "# A" },
      { filename: "z.md", content: "# Z" },
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/gists/abc123",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }),
    )
  })

  it("orders Markdown filenames by locale-independent code units", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            files: {
              "ä.md": { filename: "ä.md", content: "locale-sensitive" },
              "z.md": { filename: "z.md", content: "code-unit-first" },
            },
          }),
          { status: 200 },
        ),
      ),
    )
    await expect(getGist("ordering")).resolves.toEqual([
      { filename: "z.md", content: "code-unit-first" },
      { filename: "ä.md", content: "locale-sensitive" },
    ])
  })

  it.each([
    [404, "not_found"],
    [403, "service_unavailable"],
    [429, "service_unavailable"],
    [500, "unknown"],
  ] as const)("maps GitHub status %s to %s", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })))
    await expect(getGist(`status${status}`)).rejects.toEqual(new GistRequestError(code, status))
  })

  it.each([
    [{}, "unknown"],
    [{ files: { "notes.txt": { filename: "notes.txt", content: "text" } } }, "not_found"],
    [
      {
        files: {
          "README.md": { filename: "README.md", content: "partial", truncated: true },
        },
      },
      "content_too_large",
    ],
    [{ files: { "README.md": { filename: "README.md" } } }, "unknown"],
  ] as const)("rejects an unusable GitHub response as %s", async (body, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
    )
    await expect(getGist(`body-${code}`)).rejects.toEqual(new GistRequestError(code, 200))
    clearRequestCacheForTests()
  })
})

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
      `/v1/shares/${token}`,
      expect.objectContaining({ cache: "no-store", credentials: "omit" }),
    )
  })

  it("evicts failed requests without retrying automatically", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: "recovered",
            created_at: "2026-01-01T00:00:00Z",
            view_count: 1,
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    await expect(getShare(token)).rejects.toThrow("network unavailable")
    expect(fetchMock).toHaveBeenCalledOnce()
    await expect(getShare(token)).resolves.toMatchObject({ content: "recovered" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
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
