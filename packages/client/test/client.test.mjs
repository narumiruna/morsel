import assert from "node:assert/strict"
import { test } from "node:test"
import { MorselApiError, MorselClient } from "../dist/index.js"

const origin = "https://morsel.example.com"
const token = "A".repeat(43)
const json = (value, status) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })

test("createShare sends Markdown and options using server-side Bearer auth", async () => {
  const calls = []
  const fetch = async (...args) => {
    calls.push(args)
    return json(
      {
        id: "a0000000-0000-4000-8000-000000000000",
        share_url: `${origin}/#/s/${token}`,
        created_at: "2026-01-01T00:00:00Z",
        telegram_instant_view: false,
      },
      201,
    )
  }
  const client = new MorselClient({ baseUrl: `${origin}/`, apiKey: "secret", fetch })
  const body = {
    content: "# Hello",
    expires_in: 3600,
    max_views: 3,
    preview: { title: "Hi", description: "Hello" },
  }
  const controller = new AbortController()
  const result = await client.createShare(body, { signal: controller.signal })
  assert.equal(result.share_url, `${origin}/#/s/${token}`)
  assert.deepEqual(calls, [
    [
      `${origin}/v1/shares`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    ],
  ])
})

test("consumeShare does not send credentials, cache, or retry", async () => {
  const calls = []
  const client = new MorselClient({
    baseUrl: origin,
    apiKey: "secret",
    fetch: async (...args) => {
      calls.push(args)
      return json(
        { content: "Hello", created_at: "2026-01-01T00:00:00Z", view_count: calls.length },
        200,
      )
    },
  })
  assert.equal((await client.consumeShare(token)).view_count, 1)
  assert.equal((await client.consumeShare(token)).view_count, 2)
  assert.deepEqual(
    calls,
    Array.from({ length: 2 }, () => [
      `${origin}/v1/shares/${token}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: undefined,
      },
    ]),
  )
})

test("revokeShare uses administrative UUID and expects an empty 204 response", async () => {
  const id = "a0000000-0000-4000-8000-000000000000"
  const calls = []
  const client = new MorselClient({
    baseUrl: origin,
    apiKey: "secret",
    fetch: async (...args) => {
      calls.push(args)
      return new Response(null, { status: 204 })
    },
  })
  assert.equal(await client.revokeShare(id), undefined)
  assert.deepEqual(calls, [
    [
      `${origin}/v1/shares/${id}`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer secret" },
        signal: undefined,
      },
    ],
  ])
})

test("creating or revoking without an API key fails before fetch; reading remains public", async () => {
  let requests = 0
  const client = new MorselClient({
    baseUrl: origin,
    fetch: async () => {
      requests++
      return json({ content: "Hello", created_at: "2026-01-01T00:00:00Z", view_count: 1 }, 200)
    },
  })
  await assert.rejects(client.createShare({ content: "Hello" }), /apiKey is required/)
  await assert.rejects(client.revokeShare("id"), /apiKey is required/)
  assert.equal(requests, 0)
  assert.equal((await client.consumeShare(token)).content, "Hello")
})

test("API errors preserve status, code and message", async () => {
  const client = new MorselClient({
    baseUrl: origin,
    fetch: async () => json({ code: "view_limit_exhausted", message: "gone" }, 410),
  })
  await assert.rejects(client.consumeShare(token), (error) => {
    assert.ok(error instanceof MorselApiError)
    assert.equal(error.status, 410)
    assert.equal(error.code, "view_limit_exhausted")
    assert.equal(error.message, "gone")
    return true
  })
})

test("proxy and malformed responses produce useful errors without leaking keys", async () => {
  const client = new MorselClient({
    baseUrl: origin,
    apiKey: "secret",
    fetch: async () => new Response("bad gateway", { status: 502 }),
  })
  await assert.rejects(client.createShare({ content: "Hello" }), {
    status: 502,
    code: "unknown",
    message: "HTTP 502",
  })
  const invalid = new MorselClient({
    baseUrl: origin,
    fetch: async () => new Response("not json", { status: 200 }),
  })
  await assert.rejects(invalid.consumeShare(token), {
    status: 200,
    code: "unknown",
    message: "Invalid JSON response",
  })
})

test("network errors propagate without retry", async () => {
  let calls = 0
  const client = new MorselClient({
    baseUrl: origin,
    fetch: async () => {
      calls++
      throw new TypeError("network offline")
    },
  })
  await assert.rejects(client.consumeShare(token), /network offline/)
  assert.equal(calls, 1)
})

test("rejects URLs that could misroute API requests or contain credentials", () => {
  for (const baseUrl of [
    "https://user:pass@example.com",
    "https://example.com/subpath",
    "https://example.com/?q=1",
    "https://example.com/#fragment",
    "file:///tmp/foo",
  ]) {
    assert.throws(() => new MorselClient({ baseUrl }), /baseUrl must be/)
  }
})
