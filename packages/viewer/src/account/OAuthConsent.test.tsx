import {
  browserSupportsWebAuthn,
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../App"
import { navigate } from "../navigation"
import { ThemeProvider } from "../theme"
import * as api from "./accountApi"
import { invalidOAuthRequest, type OAuthRequest } from "./oauth"

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}))

const A = "10000000-0000-4000-8000-000000000001"
const B = "20000000-0000-4000-8000-000000000002"
const handle = "A".repeat(43)
const otherHandle = "E".repeat(43)
const path = `/oauth/consent?request=${handle}`
const requestPath = `account/oauth/requests/${handle}`
const callback =
  "http://127.0.0.1:37481/callback?code=one-use-secret&state=opaque&iss=https%3A%2F%2Fmorsel.example"
const identity = (id = A): api.Account => ({
  authenticated: true,
  setup_required: false,
  account_id: id,
  display_name: id === A ? "Alpha" : "Beta",
  csrf_token: `csrf-${id}`,
  verification_required: false,
})
const details = (id = A, name = "Pi"): OAuthRequest => ({
  client_id: "client-123",
  client_name: name,
  redirect_host: "127.0.0.1:37481",
  resource: "https://morsel.example/mcp",
  scope: "mcp:shares offline_access",
  expires_at: new Date(Date.now() + 600000).toISOString(),
  account_id: id,
})
class Channel {
  static latest: Channel
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage = vi.fn()
  close = vi.fn()
  constructor() {
    Channel.latest = this
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
let account: api.Account
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let replace: ReturnType<typeof vi.fn>
let intercept: ((path: string, init?: RequestInit) => Promise<Response> | undefined) | undefined
const json = (body: unknown, id: string | null = account.account_id ?? A, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: id ? { "X-Morsel-Account-ID": id } : {},
  })
const decisions = () =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes("/oauth/requests/") && init?.method === "POST",
  )
function show(url = path, strict = false) {
  window.history.replaceState({}, "", url)
  const app = (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  )
  return render(strict ? <StrictMode>{app}</StrictMode> : app)
}
async function decide(approve = true) {
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: approve ? "Approve access" : "Deny access" }))
}
async function change(event: "focus" | "broadcast" = "focus") {
  account = identity(B)
  act(() => {
    if (event === "broadcast") Channel.latest.onmessage?.({ data: "invalidate" })
    else fireEvent(window, new Event("focus"))
  })
  await screen.findByText("Account: Beta")
}
beforeEach(() => {
  account = identity()
  intercept = undefined
  replace = vi.fn()
  vi.stubGlobal("BroadcastChannel", Channel)
  const nativeWindow = window
  const nativeLocation = window.location
  vi.stubGlobal(
    "window",
    new Proxy(nativeWindow, {
      get(target, key) {
        if (key === "location")
          return {
            get href() {
              return nativeLocation.href
            },
            get origin() {
              return nativeLocation.origin
            },
            get pathname() {
              return nativeLocation.pathname
            },
            get search() {
              return nativeLocation.search
            },
            get hash() {
              return nativeLocation.hash
            },
            replace,
          }
        return Reflect.get(target, key, target)
      },
    }),
  )
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true)
  vi.mocked(startAuthentication).mockResolvedValue({ id: "credential" } as never)
  let bound: string | undefined
  let used = false
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = String(input).replace("/v1/", "")
    const pending = intercept?.(request, init)
    if (pending) return pending
    if (request === "account") return json(account)
    if (request.startsWith("account/oauth/requests/")) {
      if (used || (bound && bound !== account.account_id))
        return json({ code: "oauth_request_invalid", message: "Invalid request." }, null, 409)
      bound = account.account_id
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        if (body.account_id !== account.account_id)
          return json({ code: "oauth_request_invalid" }, null, 409)
        used = true
        return json({ redirect_url: callback })
      }
      return json(details(account.account_id, request.endsWith(otherHandle) ? "Second app" : "Pi"))
    }
    if (request === "auth/login/finish") account = identity()
    if (request.endsWith("/begin")) return json({ publicKey: {} })
    if (request.endsWith("/finish")) return json({})
    throw new Error(`Unexpected request ${request}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

describe("OAuth consent", () => {
  it("loads only on GET under StrictMode and shows the account, unverified identity, and all permissions", async () => {
    const { container } = show(path, true)
    await screen.findByRole("heading", { name: "Review app access" })
    expect(screen.getByRole("heading", { name: "Connect app" })).toHaveFocus()
    expect(screen.getByText("Account: Alpha")).toBeInTheDocument()
    expect(screen.getByText(A)).toBeInTheDocument()
    for (const value of [
      "Unverified app name",
      "Client ID",
      "Redirect host",
      "Resource",
      "Scope",
      "client-123",
      "create_share",
      "get_share",
      "revoke_share",
      "mcp:shares offline_access",
    ])
      expect(screen.getByText(value)).toBeInTheDocument()
    expect(screen.getByText(/Persistent access: up to 30 days/)).toHaveTextContent(
      "Access tokens expire after 10 minutes.",
    )
    expect(screen.getByText(/Each read consumes one view/)).toHaveTextContent("any account")
    expect(decisions()).toHaveLength(0)
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
  })

  it("does not describe persistent access without offline_access", async () => {
    intercept = (request) =>
      request === requestPath
        ? Promise.resolve(json({ ...details(), scope: "mcp:shares" }))
        : undefined
    show()
    await screen.findByText(
      "Access tokens expire after 10 minutes. No persistent access was requested.",
    )
    expect(screen.queryByText(/Persistent access:/)).not.toBeInTheDocument()
  })

  it("preserves the exact request query through passkey login without automatic approval", async () => {
    account = { authenticated: false, setup_required: false }
    show()
    await screen.findByRole("heading", { name: "Sign in" })
    expect(new URLSearchParams(window.location.search).get("next")).toBe(path)
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign in with passkey" }))
    await screen.findByRole("button", { name: "Approve access" })
    expect(`${window.location.pathname}${window.location.search}`).toBe(path)
    expect(decisions()).toHaveLength(0)
    expect(replace).not.toHaveBeenCalled()
  })

  it.each([
    "/oauth/consent",
    `/oauth/consent?request=${"A".repeat(42)}B`,
    `${path}&extra=1`,
    `${path}&request=${handle}`,
    `${path}#fragment`,
    `/oauth/consent?request=%41${"A".repeat(42)}`,
  ])("does not fetch or decide a noncanonical request: %s", async (url) => {
    show(url)
    await screen.findByText(invalidOAuthRequest)
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/oauth/requests/")),
    ).toHaveLength(0)
    expect(replace).not.toHaveBeenCalled()
  })

  it("retries a failed GET only after explicit action", async () => {
    let attempts = 0
    intercept = (request) =>
      request === requestPath && ++attempts === 1
        ? Promise.reject(new TypeError("network"))
        : undefined
    show()
    await screen.findByText(/could not be completed/)
    expect(attempts).toBe(1)
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry request" }))
    await screen.findByRole("button", { name: "Approve access" })
    expect(attempts).toBe(2)
    expect(decisions()).toHaveLength(0)
  })

  it.each(["GET", "POST"])(
    "stops invalid/expired/used requests after %s without redirect or replay",
    async (method) => {
      if (method === "POST") {
        show()
        await screen.findByRole("button", { name: "Approve access" })
      }
      intercept = (request, init) =>
        request === requestPath && init?.method === method
          ? Promise.resolve(
              json({ code: "oauth_request_invalid", message: "Invalid request." }, null, 409),
            )
          : undefined
      if (method === "GET") show()
      else await decide()
      await screen.findByText(invalidOAuthRequest)
      expect(screen.queryByRole("button", { name: "Retry request" })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Approve access" })).not.toBeInTheDocument()
      expect(decisions()).toHaveLength(method === "GET" ? 0 : 1)
      expect(replace).not.toHaveBeenCalled()
    },
  )

  it.each([true, false])(
    "preflights identity and CSRF, binds displayed account, and redirects only after final marked verification: approve=%s",
    async (approve) => {
      const storage = vi.spyOn(Storage.prototype, "setItem")
      const navigation = vi.fn()
      window.addEventListener("morsel:navigate", navigation)
      try {
        show()
        await screen.findByRole("button", { name: "Approve access" })
        account.csrf_token = "current-csrf"
        await decide(approve)
        await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith(callback))
        expect(decisions()).toHaveLength(1)
        expect(decisions()[0]?.[1]).toMatchObject({
          body: JSON.stringify({ approve, account_id: A }),
          credentials: "same-origin",
          cache: "no-store",
          headers: { "X-CSRF-Token": "current-csrf" },
        })
        expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/v1/account")
        expect(fetchMock.mock.calls.filter(([url]) => url === "/v1/account")).toHaveLength(3)
        expect(startAuthentication).not.toHaveBeenCalled()
        expect(storage).not.toHaveBeenCalled()
        expect(navigation).not.toHaveBeenCalled()
        expect(document.body).not.toHaveTextContent("one-use-secret")
        expect(JSON.stringify(window.history.state)).not.toContain("one-use-secret")
        expect(window.location.href).not.toContain("one-use-secret")
        expect(Channel.latest.postMessage).not.toHaveBeenCalled()
        expect(
          fetchMock.mock.calls.every(
            ([, init]) => !("X-Morsel-Account-ID" in (init?.headers ?? {})),
          ),
        ).toBe(true)
      } finally {
        window.removeEventListener("morsel:navigate", navigation)
      }
    },
  )

  it("requires fresh verification for approval based on current preflight, not stale page state", async () => {
    show()
    await screen.findByRole("button", { name: "Approve access" })
    account = { ...account, verification_required: true, csrf_token: "new-csrf" }
    await decide()
    await waitFor(() => expect(replace).toHaveBeenCalledOnce())
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls.indexOf("/v1/auth/verify/finish")).toBeLessThan(
      urls.lastIndexOf(`/v1/${requestPath}`),
    )
    expect(startAuthentication).toHaveBeenCalledOnce()
    expect(
      fetchMock.mock.calls.find(([url]) => url === "/v1/auth/verify/begin")?.[1]?.headers,
    ).toHaveProperty("X-CSRF-Token", "new-csrf")
  })

  it("permits denial without freshness or passkey support", async () => {
    account.verification_required = true
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false)
    show()
    expect(await screen.findByRole("button", { name: "Approve access" })).toBeDisabled()
    await decide(false)
    await waitFor(() => expect(replace).toHaveBeenCalledOnce())
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(decisions()[0]?.[1]?.body).toBe(JSON.stringify({ approve: false, account_id: A }))
  })

  it("does not approve after cancelled verification and still permits denial", async () => {
    account.verification_required = true
    vi.mocked(startAuthentication).mockRejectedValueOnce(
      new DOMException("cancelled", "NotAllowedError"),
    )
    show()
    await decide()
    await screen.findByText(/cancelled or timed out/)
    expect(decisions()).toHaveLength(0)
    await decide(false)
    await waitFor(() => expect(replace).toHaveBeenCalledOnce())
    expect(startAuthentication).toHaveBeenCalledOnce()
  })

  it.each(["preflight", "prompt", "decision"])(
    "synchronously locks duplicate submissions during %s",
    async (stage) => {
      const pending = deferred<Response>()
      const prompt = deferred<never>()
      account.verification_required = stage === "prompt"
      show()
      const button = await screen.findByRole("button", { name: "Approve access" })
      if (stage === "prompt") vi.mocked(startAuthentication).mockReturnValueOnce(prompt.promise)
      else
        intercept = (request, init) =>
          (
            stage === "preflight"
              ? request === "account"
              : request === requestPath && init?.method === "POST"
          )
            ? pending.promise
            : undefined
      act(() => {
        fireEvent.click(button)
        fireEvent.click(button)
      })
      await waitFor(() =>
        stage === "prompt"
          ? expect(startAuthentication).toHaveBeenCalledOnce()
          : expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
              stage === "preflight" ? "/v1/account" : `/v1/${requestPath}`,
            ),
      )
      expect(button).toBeDisabled()
      expect(decisions()).toHaveLength(stage === "decision" ? 1 : 0)
      if (stage === "prompt")
        await act(async () => prompt.reject(new DOMException("cancel", "NotAllowedError")))
      else await act(async () => pending.reject(new TypeError("network")))
      await screen.findByText(
        stage === "prompt" ? /cancelled or timed out/ : /could not be completed/,
      )
      expect(button).toBeEnabled()
    },
  )

  it.each(["network", "403"])(
    "never replays a failed %s decision; retry is explicit",
    async (failure) => {
      show()
      await screen.findByRole("button", { name: "Approve access" })
      intercept = (request, init) =>
        request === requestPath && init?.method === "POST"
          ? failure === "network"
            ? Promise.reject(new TypeError("lost response"))
            : Promise.resolve(json({ code: "verification_required" }, null, 403))
          : undefined
      await decide()
      await screen.findByText(
        failure === "network" ? /could not be completed/ : /Authorization expired/,
      )
      expect(decisions()).toHaveLength(1)
      expect(replace).not.toHaveBeenCalled()
      intercept = undefined
      account.verification_required = true
      await decide()
      await waitFor(() => expect(replace).toHaveBeenCalledOnce())
      expect(decisions()).toHaveLength(2)
      expect(startAuthentication).toHaveBeenCalledOnce()
    },
  )

  it.each(["GET", "POST"].flatMap((method) => [null, B].map((marker) => ({ method, marker }))))(
    "rejects $method responses with account marker $marker",
    async ({ method, marker }) => {
      if (method === "POST") {
        show()
        await screen.findByRole("button", { name: "Approve access" })
      }
      let captured = false
      intercept = (request, init) => {
        if (request !== requestPath || init?.method !== method || captured) return
        captured = true
        account = identity(B)
        return Promise.resolve(
          json(
            method === "GET" ? details(B, "PRIVATE-STALE-CLIENT") : { redirect_url: callback },
            marker,
          ),
        )
      }
      if (method === "GET") show()
      else await decide()
      await screen.findByText("Account: Beta")
      expect(document.body).not.toHaveTextContent("PRIVATE-STALE-CLIENT")
      expect(replace).not.toHaveBeenCalled()
      expect(decisions()).toHaveLength(method === "POST" ? 1 : 0)
    },
  )

  it.each([B, undefined])(
    "rejects consent body account %s even with the expected header",
    async (bound) => {
      let captured = false
      intercept = (request) => {
        if (request !== requestPath || captured) return
        captured = true
        account = identity(B)
        return Promise.resolve(
          json({ ...details(B, "PRIVATE-STALE-CLIENT"), account_id: bound }, A),
        )
      }
      show()
      await screen.findByText("Account: Beta")
      expect(document.body).not.toHaveTextContent("PRIVATE-STALE-CLIENT")
      expect(decisions()).toHaveLength(0)
    },
  )

  it("does not approve or prompt when preflight discovers a silent cookie change", async () => {
    show()
    await screen.findByRole("button", { name: "Approve access" })
    account = { ...identity(B), verification_required: true }
    await decide()
    await screen.findByText("Account: Beta")
    expect(decisions()).toHaveLength(0)
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it("sends the displayed account ID when the cookie changes after preflight and never redirects or replays", async () => {
    show()
    await screen.findByRole("button", { name: "Approve access" })
    intercept = (request) => {
      if (request !== "account") return
      account = identity(B)
      intercept = undefined
      return Promise.resolve(json(identity(A), A))
    }
    await decide()
    await screen.findByText(invalidOAuthRequest)
    expect(decisions()).toHaveLength(1)
    expect(decisions()[0]?.[1]?.body).toBe(JSON.stringify({ approve: true, account_id: A }))
    expect(replace).not.toHaveBeenCalled()
  })

  it.each(["focus", "broadcast"] as const)(
    "aborts verification on %s account change",
    async (event) => {
      account.verification_required = true
      const pending = deferred<never>()
      vi.mocked(startAuthentication).mockReturnValueOnce(pending.promise)
      show()
      await decide()
      await waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce())
      await change(event)
      expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalled()
      await act(async () => pending.resolve({ id: "late" } as never))
      expect(fetchMock.mock.calls.some(([url]) => url === "/v1/auth/verify/finish")).toBe(false)
      expect(decisions()).toHaveLength(0)
      expect(replace).not.toHaveBeenCalled()
    },
  )

  it.each(
    ["GET", "POST"].flatMap((method) =>
      ["focus", "broadcast", "unmount"].map((event) => ({ method, event })),
    ),
  )("aborts pending $method on $event and discards late data", async ({ method, event }) => {
    const pending = deferred<Response>()
    let signal: AbortSignal | null | undefined
    let captured = false
    if (method === "POST") {
      show()
      await screen.findByRole("button", { name: "Approve access" })
    }
    intercept = (request, init) => {
      if (request !== requestPath || init?.method !== method || captured) return
      captured = true
      signal = init.signal
      return pending.promise
    }
    const page = method === "GET" ? show() : undefined
    if (method === "POST") await decide()
    await waitFor(() => expect(captured).toBe(true))
    if (event === "unmount") {
      if (page) page.unmount()
      else act(() => navigate("/"))
    } else await change(event as "focus" | "broadcast")
    expect(signal?.aborted).toBe(true)
    await act(async () =>
      pending.resolve(
        json(method === "GET" ? details(A, "PRIVATE-LATE-CLIENT") : { redirect_url: callback }, A),
      ),
    )
    expect(document.body).not.toHaveTextContent("PRIVATE-LATE-CLIENT")
    expect(replace).not.toHaveBeenCalled()
  })

  it.each(["GET", "POST"])(
    "checks identity again after a delayed %s response body",
    async (method) => {
      if (method === "POST") {
        show()
        await screen.findByRole("button", { name: "Approve access" })
      }
      const body = deferred<unknown>()
      let captured = false
      intercept = (request, init) => {
        if (request !== requestPath || init?.method !== method || captured) return
        captured = true
        const response = json({})
        vi.spyOn(response, "json").mockReturnValueOnce(body.promise)
        return Promise.resolve(response)
      }
      if (method === "GET") show()
      else await decide()
      await waitFor(() => expect(captured).toBe(true))
      await change("broadcast")
      await act(async () =>
        body.resolve(
          method === "GET" ? details(A, "PRIVATE-LATE-CLIENT") : { redirect_url: callback },
        ),
      )
      expect(document.body).not.toHaveTextContent("PRIVATE-LATE-CLIENT")
      expect(replace).not.toHaveBeenCalled()
    },
  )

  it.each(["preflight", "decision", "redirect"])(
    "checks the account in the microtask immediately before %s continuation",
    async (stage) => {
      show()
      await screen.findByRole("button", { name: "Approve access" })
      const original = api.accountRequest
      let reads = 0
      let captured = false
      const spy = vi
        .spyOn(api, "accountRequest")
        .mockImplementation(
          async <T,>(
            request: string,
            options: Parameters<typeof api.accountRequest>[1],
          ): Promise<T> => {
            const result = await original<T>(request, options)
            if (request === "account") reads++
            if (
              !captured &&
              (stage === "decision"
                ? request === requestPath && options?.method === "POST"
                : request === "account" && reads === (stage === "preflight" ? 1 : 2))
            ) {
              captured = true
              queueMicrotask(() => {
                account = identity(B)
                Channel.latest.onmessage?.({ data: "invalidate" })
              })
            }
            return result
          },
        )
      try {
        await decide()
        await screen.findByText("Account: Beta")
        expect(captured).toBe(true)
        expect(decisions()).toHaveLength(stage === "preflight" ? 0 : 1)
        expect(replace).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    },
  )

  it.each(["GET", "POST"])(
    "aborts an old %s on request-handle replacement without retaining its decision",
    async (method) => {
      if (method === "POST") {
        show()
        await screen.findByRole("button", { name: "Approve access" })
      }
      const pending = deferred<Response>()
      let signal: AbortSignal | null | undefined
      intercept = (request, init) => {
        if (request !== requestPath || init?.method !== method) return
        signal = init.signal
        return pending.promise
      }
      if (method === "GET") show()
      else await decide()
      await waitFor(() => expect(signal).toBeTruthy())
      act(() => navigate(`/oauth/consent?request=${otherHandle}`))
      await screen.findByText("Second app")
      expect(signal?.aborted).toBe(true)
      await act(async () =>
        pending.resolve(
          json(method === "GET" ? details(A, "PRIVATE-LATE-CLIENT") : { redirect_url: callback }),
        ),
      )
      expect(document.body).not.toHaveTextContent("PRIVATE-LATE-CLIENT")
      expect(replace).not.toHaveBeenCalled()
      expect(decisions()).toHaveLength(method === "GET" ? 0 : 1)
    },
  )

  it.each(["foreign", "missing", "network"])(
    "discards the one-use callback if final account verification is %s",
    async (failure) => {
      show()
      await screen.findByRole("button", { name: "Approve access" })
      let reads = 0
      intercept = (request) => {
        if (request !== "account" || ++reads !== 2) return
        if (failure === "network") return Promise.reject(new TypeError("network"))
        if (failure === "foreign") account = identity(B)
        return Promise.resolve(json(account, failure === "foreign" ? B : null))
      }
      await decide()
      if (failure === "foreign" || failure === "missing")
        await screen.findByText(`Account: ${failure === "foreign" ? "Beta" : "Alpha"}`)
      else await screen.findByText(invalidOAuthRequest)
      expect(replace).not.toHaveBeenCalled()
      expect(decisions()).toHaveLength(1)
    },
  )

  it("does not use a malformed callback or expose its contents", async () => {
    show()
    await screen.findByRole("button", { name: "Approve access" })
    intercept = (request, init) =>
      request === requestPath && init?.method === "POST"
        ? Promise.resolve(json({ redirect_url: "javascript:PRIVATE-SECRET" }))
        : undefined
    await decide()
    await screen.findByText(invalidOAuthRequest)
    expect(replace).not.toHaveBeenCalled()
    expect(document.body).not.toHaveTextContent("PRIVATE-SECRET")
  })

  it.each(["navigation", "handle", "unmount"])(
    "discards the callback on a final-verification %s microtask",
    async (event) => {
      const page = show()
      await screen.findByRole("button", { name: "Approve access" })
      const original = api.accountRequest
      let reads = 0
      const spy = vi
        .spyOn(api, "accountRequest")
        .mockImplementation(
          async <T,>(
            request: string,
            options: Parameters<typeof api.accountRequest>[1],
          ): Promise<T> => {
            const result = await original<T>(request, options)
            if (request === "account" && ++reads === 2)
              queueMicrotask(() => {
                if (event === "unmount") page.unmount()
                else navigate(event === "handle" ? `/oauth/consent?request=${otherHandle}` : "/")
              })
            return result
          },
        )
      try {
        await decide()
        await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2))
        expect(replace).not.toHaveBeenCalled()
        expect(decisions()).toHaveLength(1)
      } finally {
        spy.mockRestore()
      }
    },
  )

  it("discards the callback after a silent cookie switch during decision body parsing", async () => {
    show()
    await screen.findByRole("button", { name: "Approve access" })
    intercept = (request, init) => {
      if (request !== requestPath || init?.method !== "POST") return
      const response = json({})
      vi.spyOn(response, "json").mockImplementationOnce(async () => {
        account = identity(B)
        return { redirect_url: callback }
      })
      return Promise.resolve(response)
    }
    await decide()
    await screen.findByText("Account: Beta")
    expect(decisions()).toHaveLength(1)
    expect(replace).not.toHaveBeenCalled()
  })

  it("aborts the native approval prompt on unmount", async () => {
    account.verification_required = true
    const prompt = deferred<never>()
    vi.mocked(startAuthentication).mockReturnValueOnce(prompt.promise)
    const page = show()
    await decide()
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce())
    page.unmount()
    expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalled()
    await act(async () => prompt.resolve({ id: "late" } as never))
    expect(fetchMock.mock.calls.some(([url]) => url === "/v1/auth/verify/finish")).toBe(false)
    expect(decisions()).toHaveLength(0)
    expect(replace).not.toHaveBeenCalled()
  })

  it("aborts a pending decision when the displayed request expires", async () => {
    const timers = vi.spyOn(window, "setTimeout")
    show()
    await screen.findByRole("button", { name: "Approve access" })
    const pending = deferred<Response>()
    let signal: AbortSignal | null | undefined
    intercept = (request, init) => {
      if (request !== requestPath || init?.method !== "POST") return
      signal = init.signal
      return pending.promise
    }
    await decide()
    await waitFor(() => expect(signal).toBeTruthy())
    const timeout = timers.mock.calls.find(
      ([, delay]) => typeof delay === "number" && delay > 590000,
    )?.[0]
    expect(typeof timeout).toBe("function")
    act(() => {
      if (typeof timeout === "function") timeout()
    })
    await screen.findByText(invalidOAuthRequest)
    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve(json({ redirect_url: callback })))
    expect(replace).not.toHaveBeenCalled()
    expect(decisions()).toHaveLength(1)
  })

  it.each(["signed out", "missing CSRF"])("does not decide when preflight is %s", async (state) => {
    show()
    await screen.findByRole("button", { name: "Approve access" })
    if (state === "signed out") account = { ...account, authenticated: false }
    else account = { ...account, csrf_token: undefined }
    await decide()
    await screen.findByRole("heading", { name: "Sign in" })
    expect(decisions()).toHaveLength(0)
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it("does not recover a bound request after the session changes within the same account", async () => {
    show()
    await screen.findByRole("button", { name: "Approve access" })
    account.csrf_token = "new-session-csrf"
    intercept = (request, init) =>
      request === requestPath && init?.method === "POST"
        ? Promise.resolve(json({ code: "oauth_request_invalid" }, null, 409))
        : undefined
    await decide()
    await screen.findByText(invalidOAuthRequest)
    expect(decisions()).toHaveLength(1)
    expect(decisions()[0]?.[1]?.headers).toHaveProperty("X-CSRF-Token", "new-session-csrf")
    expect(screen.getByText("Account: Alpha")).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it("does not turn a fragmented consent arrival into an accepted login continuation", async () => {
    account = { authenticated: false, setup_required: false }
    show(`${path}#fragment`)
    await screen.findByRole("heading", { name: "Sign in" })
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/manage/shares")
    expect(decisions()).toHaveLength(0)
  })

  it("rejects an already-expired request returned by GET", async () => {
    intercept = (request) =>
      request === requestPath
        ? Promise.resolve(
            json({ ...details(), expires_at: new Date(Date.now() - 1).toISOString() }),
          )
        : undefined
    show()
    await screen.findByText(invalidOAuthRequest)
    expect(decisions()).toHaveLength(0)
  })
})
