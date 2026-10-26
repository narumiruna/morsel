import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  WebAuthnError,
} from "@simplewebauthn/browser"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AccountError, accountErrorMessage, accountRequest, authenticate } from "./accountApi"

vi.mock("@simplewebauthn/browser", async (original) => ({
  ...(await original<typeof import("@simplewebauthn/browser")>()),
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}))

const options = { challenge: "base64url-challenge" }
const credential = { id: "credential-id", response: { clientDataJSON: "raw" } }
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true)
  vi.mocked(startAuthentication).mockResolvedValue(credential as never)
  vi.mocked(startRegistration).mockResolvedValue(credential as never)
  fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async (url) =>
        new Response(JSON.stringify(String(url).endsWith("/begin") ? { publicKey: options } : {})),
    )
  vi.stubGlobal("fetch", fetchMock)
})

describe("accountRequest", () => {
  it.each([
    [403, "verification_required"],
    [403, "csrf_invalid"],
    [404, "link_unavailable"],
    [404, "not_found"],
  ] as const)(
    "preserves unmarked %s %s errors from pre-authorization failures",
    async (status, code) => {
      const invalidate = vi.fn()
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ code, message: "Request rejected." }), { status }),
      )
      await expect(
        accountRequest("account/shares/id/link", {
          expectedAccount: { id: "A", isCurrent: () => true, invalidate },
        }),
      ).rejects.toMatchObject({ status, code })
      expect(invalidate).not.toHaveBeenCalled()
    },
  )

  it("rejects an unmarked error after the current identity changes", async () => {
    const invalidate = vi.fn()
    let current = true
    fetchMock.mockImplementationOnce(async () => {
      current = false
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404 })
    })
    await expect(
      accountRequest("passkeys", {
        expectedAccount: { id: "A", isCurrent: () => current, invalidate },
      }),
    ).rejects.toMatchObject({ code: "account_changed" })
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it.each([null, "other-account"])(
    "rejects a private response with marker %s without replay",
    async (marker) => {
      const invalidate = vi.fn()
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ key: "private-key" }), {
          headers: marker ? { "X-Morsel-Account-ID": marker } : {},
        }),
      )
      await expect(
        accountRequest("api-keys", {
          method: "POST",
          body: { name: "CLI" },
          expectedAccount: { id: "expected-account", isCurrent: () => true, invalidate },
        }),
      ).rejects.toMatchObject({ code: "account_changed" })
      expect(invalidate).toHaveBeenCalledOnce()
      expect(fetchMock).toHaveBeenCalledOnce()
    },
  )

  it("checks current identity again after the response body completes", async () => {
    let current = true
    const invalidate = vi.fn()
    const response = new Response("{}", { headers: { "X-Morsel-Account-ID": "A" } })
    vi.spyOn(response, "json").mockImplementationOnce(async () => {
      current = false
      return { key: "must-not-return" }
    })
    fetchMock.mockResolvedValueOnce(response)
    await expect(
      accountRequest("api-keys", {
        expectedAccount: { id: "A", isCurrent: () => current, invalidate },
      }),
    ).rejects.toMatchObject({ code: "account_changed" })
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it("does not send a request from an obsolete identity", async () => {
    const invalidate = vi.fn()
    await expect(
      accountRequest("passkeys", {
        expectedAccount: { id: "A", isCurrent: () => false, invalidate },
      }),
    ).rejects.toMatchObject({ code: "account_changed" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects authenticated account bodies without a matching identity marker", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          authenticated: true,
          setup_required: false,
          account_id: "A",
          display_name: "Alpha",
        }),
      ),
    )
    await expect(accountRequest("account")).rejects.toMatchObject({ code: "account_changed" })
  })

  it("uses same-origin cookies and no cache, without bearer authentication", async () => {
    await accountRequest("account")
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/account",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      }),
    )
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body")
  })

  it("sends JSON and session CSRF for mutations and accepts an empty 204 response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const controller = new AbortController()
    await expect(
      accountRequest("auth/logout", {
        method: "POST",
        body: {},
        csrf: "session-csrf",
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: "{}",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "session-csrf" },
    })
  })

  it.each([401, 403, 409, 429, 500])(
    "preserves safe server error fields for status %s",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "rejected", message: "Request rejected." }), {
          status,
        }),
      )
      await expect(accountRequest("account")).rejects.toMatchObject({
        status,
        code: "rejected",
        message: "Request rejected.",
      })
    },
  )

  it.each(["not JSON", "null", "{}", "[]"])("handles malformed error bodies: %s", async (body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 500 }))
    await expect(accountRequest("account")).rejects.toMatchObject({
      status: 500,
      code: "request_failed",
      message: "The request failed. Try again.",
    })
  })
})

describe("authenticate", () => {
  it.each(["login", "setup", "invite", "recover"] as const)(
    "invalidates other tabs after successful %s without sending secrets",
    async (operation) => {
      const invalidated = vi.fn()
      window.addEventListener("morsel:account-invalidation", invalidated)
      try {
        await authenticate(operation, {
          token: "private-grant",
          display_name: "Private account name",
        })
        expect(invalidated).toHaveBeenCalledOnce()
        const event = invalidated.mock.calls[0]?.[0]
        expect(event).toBeInstanceOf(Event)
        expect(event).not.toHaveProperty("detail")
      } finally {
        window.removeEventListener("morsel:account-invalidation", invalidated)
      }
    },
  )

  it.each(["setup", "invite", "recover", "passkey"] as const)(
    "uses registration for %s and passes raw credential JSON",
    async (operation) => {
      const signal = new AbortController().signal
      await authenticate(operation, { token: "operator-token", name: "Device" }, "csrf", signal)
      expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: options })
      expect(startAuthentication).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls[1]).toEqual([
        `/v1/auth/${operation}/finish`,
        expect.objectContaining({
          body: JSON.stringify(credential),
          signal,
          headers: expect.objectContaining({ "X-CSRF-Token": "csrf" }),
        }),
      ])
    },
  )

  it.each(["login", "verify"] as const)("uses assertions for %s", async (operation) => {
    await authenticate(operation, {}, "csrf")
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options })
    expect(startRegistration).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(credential))
  })

  it("does not start HTTP or WebAuthn for unsupported browsers", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false)
    await expect(authenticate("login", {})).rejects.toThrow("does not support passkeys")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not finish an aborted flow after the browser returns", async () => {
    const controller = new AbortController()
    vi.mocked(startAuthentication).mockImplementationOnce(async () => {
      controller.abort()
      return credential as never
    })
    await expect(authenticate("verify", {}, "csrf", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(["login", "setup"] as const)(
    "cancels the native %s prompt on page abort",
    async (operation) => {
      const controller = new AbortController()
      let cancel: () => void = () => {}
      const pending = new Promise<never>((_, reject) => {
        cancel = () => reject(new DOMException("Page left", "AbortError"))
      })
      const start = operation === "login" ? startAuthentication : startRegistration
      vi.mocked(start).mockImplementationOnce(() => {
        controller.abort()
        return pending
      })
      vi.mocked(WebAuthnAbortService.cancelCeremony).mockImplementationOnce(() => cancel())
      await expect(authenticate(operation, {}, undefined, controller.signal)).rejects.toMatchObject(
        { name: "AbortError" },
      )
      expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it("removes the native cancellation listener after prompt completion", async () => {
    const controller = new AbortController()
    await authenticate("login", {}, undefined, controller.signal)
    controller.abort()
    expect(WebAuthnAbortService.cancelCeremony).not.toHaveBeenCalled()
  })

  it("does not open a native prompt if the page left while begin completed", async () => {
    const controller = new AbortController()
    fetchMock.mockImplementationOnce(async () => {
      controller.abort()
      return new Response(JSON.stringify({ publicKey: options }))
    })
    await expect(authenticate("login", {}, undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("propagates prompt failures without posting a finish", async () => {
    vi.mocked(startRegistration).mockRejectedValueOnce(new Error("authenticator failed"))
    await expect(authenticate("setup", { token: "token" })).rejects.toThrow("authenticator failed")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not prompt after begin fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }))
    await expect(authenticate("verify", {}, "csrf")).rejects.toBeInstanceOf(AccountError)
    expect(startAuthentication).not.toHaveBeenCalled()
  })
})

describe("accountErrorMessage", () => {
  it("maps real helper cancellation errors without exposing their payload", () => {
    const error = new WebAuthnError({
      message: "sensitive browser detail",
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      cause: new DOMException("cancelled", "NotAllowedError"),
    })
    expect(accountErrorMessage(error)).toMatch(/cancelled or timed out/)
    expect(accountErrorMessage(new DOMException("cancelled", "NotAllowedError"))).toMatch(
      /cancelled or timed out/,
    )
  })

  it("maps duplicate registration and does not show arbitrary network or browser errors", () => {
    expect(accountErrorMessage(new DOMException("duplicate", "InvalidStateError"))).toMatch(
      /already registered/,
    )
    expect(accountErrorMessage(new Error("private details"))).not.toContain("private details")
    expect(accountErrorMessage(null)).toMatch(/could not be completed/)
  })

  it.each([
    [401, "session expired"],
    [403, "Authorization expired"],
    [409, "Last passkey"],
  ] as const)("maps %s into an actionable message", (status, message) => {
    expect(accountErrorMessage(new AccountError(status, "rejected", "Last passkey"))).toContain(
      message,
    )
  })
})
