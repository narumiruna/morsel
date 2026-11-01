import { describe, expect, it } from "vitest"
import { consentRequestHandle, isOAuthCallback } from "./oauth"

const handle = "A".repeat(43)

describe("consent handles", () => {
  it.each(Array.from("AEIMQUYcgkosw048"))("accepts canonical final character %s", (last) => {
    const value = `${"_".repeat(42)}${last}`
    expect(consentRequestHandle(`?request=${value}`)).toBe(value)
  })

  it.each([
    "",
    `?request=${handle}B`,
    `?request=${handle.slice(1)}`,
    `?request=${"A".repeat(42)}B`,
    `?request=${handle}=`,
    `?request=%41${handle.slice(1)}`,
    `?request=${handle}&request=${handle}`,
    `?request=${handle}&next=/account`,
    `?request=${handle}#fragment`,
    `?request=${handle}\n`,
    `?request=${handle}&`,
    `?%72equest=${handle}`,
    `?request=${handle.replace("A", "+")}`,
  ])("rejects noncanonical or additional input: %s", (search) => {
    expect(consentRequestHandle(search)).toBeNull()
  })
})

describe("callback URL defense", () => {
  it.each([
    "https://client.example/callback?code=one-use&state=arbitrary%26value&iss=https%3A%2F%2Fmorsel.example",
    "https://client.example/callback?error=access_denied&state=unchanged",
    "http://127.0.0.1:37481/callback?code=one-use",
    "http://[::1]:37481/callback?code=one-use",
    "http://localhost:37481/callback?code=one-use",
  ])("accepts an absolute HTTPS or loopback callback: %s", (url) => {
    expect(isOAuthCallback(url)).toBe(true)
  })

  it.each([
    null,
    {},
    "/account",
    "//client.example/callback",
    "javascript:alert(1)",
    "data:text/html,secret",
    "http://client.example/callback",
    "http://localhost.example/callback",
    "http://127.0.0.1.evil.example/callback",
    "https://user:pass@client.example/callback",
    "https://client.example/callback#secret",
    " https://client.example/callback",
    "https://client.example/call\nback",
    "https://client.example/\u0000callback",
  ])("rejects unsafe callback shape: %s", (url) => {
    expect(isOAuthCallback(url)).toBe(false)
  })
})
