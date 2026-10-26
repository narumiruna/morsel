import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../App"
import { ThemeProvider } from "../theme"
import * as accountApi from "./accountApi"
import { type Account, accountChannel } from "./accountApi"

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}))

const A = "10000000-0000-4000-8000-000000000001"
const B = "20000000-0000-4000-8000-000000000002"
const created = "2026-10-26T00:00:00Z"
const shareID = "30000000-0000-4000-8000-000000000003"
const secret = "STALE-PRIVATE-SECRET"
const savedLink = `https://example.test/#/s/${"A".repeat(43)}`
const share = (id: string) => ({
  id: shareID,
  label: `${id === A ? "Alpha" : "Beta"} share`,
  created_at: created,
  expires_at: null,
  max_views: null,
  view_count: 0,
  revoked_at: null,
  status: "active",
  link_available: true,
})
const identity = (id: string): Account => ({
  authenticated: true,
  setup_required: false,
  account_id: id,
  display_name: id === A ? "Alpha" : "Beta",
  csrf_token: `csrf-${id}`,
  verification_required: false,
})
const json = (body: unknown, id = accountID, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "X-Morsel-Account-ID": id },
  })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}
class Channel {
  static instances: Channel[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage = vi.fn()
  close = vi.fn()
  constructor(public name: string) {
    Channel.instances.push(this)
  }
}
let accountID: string
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let intercept:
  | ((path: string, init: RequestInit | undefined, id: string) => Promise<Response> | undefined)
  | undefined

beforeEach(() => {
  accountID = A
  intercept = undefined
  Channel.instances = []
  vi.stubGlobal("BroadcastChannel", Channel)
  vi.stubGlobal("ClipboardItem", undefined)
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true)
  vi.mocked(startAuthentication).mockResolvedValue({ id: "credential" } as never)
  vi.mocked(startRegistration).mockResolvedValue({ id: "credential" } as never)
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).replace("/v1/", "")
    const id = accountID
    const pending = intercept?.(path, init, id)
    if (pending) return pending
    if (path === "account") return json(identity(id), id)
    if (path.startsWith("account/shares?"))
      return json({ items: [share(id)], matching_count: 1 }, id)
    if (path.endsWith("/link")) return json({ share_url: savedLink }, id)
    if (path.startsWith("account/shares/"))
      return json({ ...share(id), content: "# Current content" }, id)
    if (path === "api-keys") return json(init?.method === "POST" ? { key: secret } : [], id)
    if (path === "passkeys")
      return json(
        [
          { id: "first", name: `${id === A ? "Alpha" : "Beta"} passkey`, created_at: created },
          { id: "second", name: "Backup", created_at: created },
        ],
        id,
      )
    if (path.endsWith("/begin")) return json({ publicKey: {} }, id)
    if (path.endsWith("/finish")) return json({}, id)
    if (init?.method === "DELETE" || path === "auth/logout")
      return new Response(null, { status: 204, headers: { "X-Morsel-Account-ID": id } })
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})
function show(path = "/manage/shares") {
  window.history.replaceState({}, "", path)
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  )
}
async function switchAccount(event: "focus" | "broadcast" | "visibility" = "focus") {
  accountID = B
  act(() => {
    if (event === "broadcast")
      Channel.instances
        .find((channel) => !channel.close.mock.calls.length)
        ?.onmessage?.({ data: "invalidate" })
    else if (event === "visibility") fireEvent(document, new Event("visibilitychange"))
    else fireEvent(window, new Event("focus"))
  })
  await screen.findByText(/Account: Beta/)
}
async function createKey() {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText("API key name"), "CLI")
  await user.click(screen.getByRole("button", { name: "Create API key" }))
}

describe("account response isolation", () => {
  it.each(["network", "unauthorized", "server"] as const)(
    "ignores a superseded initial identity failure: %s",
    async (kind) => {
      const pending = deferred<Response>()
      let captured = false
      intercept = (path) => {
        if (path !== "account" || captured) return
        captured = true
        return pending.promise
      }
      show()
      await waitFor(() => expect(captured).toBe(true))
      await switchAccount()
      await act(async () => {
        if (kind === "network") pending.reject(new TypeError("Stale network failure"))
        else
          pending.resolve(
            json(
              { code: "unavailable", message: "Stale identity failure" },
              A,
              kind === "unauthorized" ? 401 : 503,
            ),
          )
      })
      expect(screen.getByText(/Account: Beta/)).toBeInTheDocument()
      expect(screen.queryByRole("alert")?.textContent ?? "").toBe("")
      expect(screen.queryByRole("button", { name: "Sign in with passkey" })).not.toBeInTheDocument()
    },
  )

  it.each(["list", "detail", "link", "key list", "passkeys", "one-time key"] as const)(
    "discards an in-flight %s response after a focus identity change",
    async (kind) => {
      const path =
        kind === "passkeys"
          ? "/account"
          : kind.includes("key")
            ? "/manage/api-keys"
            : "/manage/shares"
      const pending = deferred<Response>()
      let signal: AbortSignal | null | undefined
      let captured = false
      const target = (requestPath: string, init?: RequestInit) =>
        kind === "list"
          ? requestPath.startsWith("account/shares?")
          : kind === "detail"
            ? requestPath === `account/shares/${shareID}`
            : kind === "link"
              ? requestPath.endsWith("/link")
              : kind === "passkeys"
                ? requestPath === "passkeys"
                : requestPath === "api-keys" &&
                  init?.method === (kind === "one-time key" ? "POST" : "GET")
      if (kind !== "passkeys" && kind !== "key list") {
        show(path)
        await screen.findByText(/Account: Alpha/)
        if (path === "/manage/shares")
          await screen.findByRole("link", { name: "Preview share Alpha share" })
      }
      intercept = (requestPath, init) => {
        if (captured || !target(requestPath, init)) return
        captured = true
        signal = init?.signal
        return pending.promise
      }
      if (kind === "passkeys" || kind === "key list") show(path)
      else if (kind === "list")
        await userEvent.setup().click(screen.getByRole("button", { name: "Refresh shares" }))
      else if (kind === "detail")
        await userEvent
          .setup()
          .click(screen.getByRole("link", { name: "Preview share Alpha share" }))
      else if (kind === "link")
        await userEvent
          .setup()
          .click(screen.getByRole("button", { name: "Copy link for Alpha share" }))
      else await createKey()
      await waitFor(() => expect(captured).toBe(true))
      await switchAccount()
      expect(signal?.aborted).toBe(true)
      const body =
        kind === "list"
          ? { items: [{ ...share(A), label: secret }], matching_count: 1 }
          : kind === "detail"
            ? { ...share(A), content: `# ${secret}` }
            : kind === "link"
              ? { share_url: savedLink }
              : kind === "one-time key"
                ? { key: secret }
                : [{ id: secret, name: secret, created_at: created }]
      await act(async () => pending.resolve(json(body, A)))
      expect(document.body).not.toHaveTextContent(secret)
      expect(screen.queryByDisplayValue(savedLink)).not.toBeInTheDocument()
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
      if (kind === "one-time key")
        expect(
          fetchMock.mock.calls.filter(
            ([url, init]) => url === "/v1/api-keys" && init?.method === "POST",
          ),
        ).toHaveLength(1)
    },
  )

  it.each(["list", "detail", "link", "passkeys", "key list"] as const)(
    "rejects a %s response authorized by a changed cookie before any identity event",
    async (kind) => {
      const path =
        kind === "passkeys"
          ? "/account"
          : kind === "key list"
            ? "/manage/api-keys"
            : "/manage/shares"
      let captured = false
      intercept = (requestPath) => {
        const match =
          kind === "passkeys"
            ? requestPath === "passkeys"
            : kind === "key list"
              ? requestPath === "api-keys"
              : kind === "list"
                ? requestPath.startsWith("account/shares?")
                : kind === "link"
                  ? requestPath.endsWith("/link")
                  : requestPath === `account/shares/${shareID}`
        if (!match || captured) return
        captured = true
        accountID = B
        const body =
          kind === "list"
            ? { items: [{ ...share(B), label: secret }], matching_count: 1 }
            : kind === "detail"
              ? { ...share(B), content: secret }
              : kind === "link"
                ? { share_url: savedLink }
                : [{ id: "foreign", name: secret }]
        return Promise.resolve(json(body, B))
      }
      show(path)
      if (kind === "detail")
        await userEvent
          .setup()
          .click(await screen.findByRole("link", { name: "Preview share Alpha share" }))
      if (kind === "link")
        await userEvent
          .setup()
          .click(await screen.findByRole("button", { name: "Copy link for Alpha share" }))
      await screen.findByText(/Account: Beta/)
      expect(document.body).not.toHaveTextContent(secret)
      expect(screen.queryByDisplayValue(savedLink)).not.toBeInTheDocument()
    },
  )

  it("does not replay a key mutation when the cookie changes between preflight and authorization", async () => {
    show("/manage/api-keys")
    await screen.findByText(/Account: Alpha/)
    intercept = (path) => {
      if (path !== "account" || accountID !== A) return
      accountID = B
      return Promise.resolve(json(identity(A), A))
    }
    await createKey()
    await screen.findByText(/Account: Beta/)
    expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(secret)
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/v1/api-keys" && init?.method === "POST",
      ),
    ).toHaveLength(1)
    expect(
      fetchMock.mock.calls.every(([, init]) => !("X-Morsel-Account-ID" in (init?.headers ?? {}))),
    ).toBe(true)
  })

  it.each(["broadcast", "visibility"] as const)(
    "clears a one-time key and navigation protection on %s invalidation",
    async (event) => {
      show("/manage/api-keys")
      await createKey()
      await screen.findByLabelText("New API key")
      await switchAccount(event)
      expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
      expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true)
      expect(Channel.instances[0]?.name).toBe(accountChannel)
    },
  )

  it("clears saved links, search, details, and confirmations on account change", async () => {
    const user = userEvent.setup()
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    show()
    await user.click(await screen.findByRole("button", { name: "Copy link for Alpha share" }))
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(savedLink))
    await user.type(screen.getByLabelText("Search shares", { exact: true }), "private draft query")
    await user.click(screen.getByRole("button", { name: "More actions for Alpha share" }))
    await user.click(screen.getByRole("menuitem", { name: "Revoke share Alpha share" }))
    await screen.findByRole("button", { name: "Confirm revocation" })
    await switchAccount("broadcast")
    expect(screen.getByLabelText("Search shares", { exact: true })).toHaveValue("")
    expect(screen.queryByRole("button", { name: "Confirm revocation" })).not.toBeInTheDocument()
    await user.click(await screen.findByRole("button", { name: "Copy link for Beta share" }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/link"))).toHaveLength(2),
    )
  })

  it.each(["share", "API key", "passkey"] as const)(
    "cancels an old %s confirmation when mutation preflight discovers a changed cookie",
    async (kind) => {
      if (kind === "API key")
        intercept = (path, init) =>
          path === "api-keys" && init?.method === "GET"
            ? Promise.resolve(
                json([
                  {
                    id: "cli",
                    name: "CLI",
                    prefix: "prefix",
                    created_at: created,
                    revoked_at: null,
                  },
                ]),
              )
            : undefined
      show(
        kind === "share" ? "/manage/shares" : kind === "API key" ? "/manage/api-keys" : "/account",
      )
      const user = userEvent.setup()
      await screen.findByText(/Account: Alpha/)
      if (kind === "share") {
        await user.click(
          await screen.findByRole("button", { name: "More actions for Alpha share" }),
        )
        await user.click(screen.getByRole("menuitem", { name: "Revoke share Alpha share" }))
      } else
        await user.click(
          await screen.findByRole("button", {
            name: kind === "API key" ? "Revoke API key CLI" : "Remove passkey Backup",
          }),
        )
      intercept = (path) => {
        if (path !== "account") return
        accountID = B
        return Promise.resolve(json(identity(B), B))
      }
      await user.click(
        screen.getByRole("button", {
          name:
            kind === "share"
              ? "Confirm revocation"
              : kind === "API key"
                ? "Confirm revoke API key"
                : "Confirm remove passkey",
        }),
      )
      await screen.findByText(/Account: Beta/)
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false)
      expect(screen.queryByRole("button", { name: /Confirm/ })).not.toBeInTheDocument()
      expect(startAuthentication).not.toHaveBeenCalled()
    },
  )

  it.each(["create", "copy"] as const)(
    "rejects a microtask identity change immediately before raw-key %s",
    async (kind) => {
      const user = userEvent.setup()
      show("/manage/api-keys")
      await screen.findByText(/Account: Alpha/)
      await user.type(await screen.findByLabelText("API key name"), "CLI")
      if (kind === "copy") {
        await user.click(screen.getByRole("button", { name: "Create API key" }))
        await screen.findByLabelText("New API key")
      }
      const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
      const original = accountApi.accountRequest
      let captured = false
      const spy = vi
        .spyOn(accountApi, "accountRequest")
        .mockImplementation(
          async <T,>(
            path: string,
            options: Parameters<typeof accountApi.accountRequest>[1],
          ): Promise<T> => {
            const result = await original<T>(path, options)
            if (path === "account" && options?.expectedAccount && !captured) {
              captured = true
              // The response passed its own checks. Invalidate before the caller
              // resumes, while React has not yet cleaned up the old component.
              queueMicrotask(() => {
                accountID = B
                Channel.instances
                  .find((channel) => !channel.close.mock.calls.length)
                  ?.onmessage?.({ data: "invalidate" })
              })
            }
            return result
          },
        )
      try {
        const before = fetchMock.mock.calls.filter(
          ([url, init]) => url === "/v1/api-keys" && init?.method === "POST",
        ).length
        await user.click(
          screen.getByRole("button", {
            name: kind === "copy" ? "Copy API key" : "Create API key",
          }),
        )
        await screen.findByText(/Account: Beta/)
        expect(captured).toBe(true)
        expect(
          fetchMock.mock.calls.filter(
            ([url, init]) => url === "/v1/api-keys" && init?.method === "POST",
          ),
        ).toHaveLength(before)
        expect(clipboard).not.toHaveBeenCalled()
        expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
      } finally {
        spy.mockRestore()
      }
    },
  )

  it("does not copy a cached capability after a silent cookie switch", async () => {
    const user = userEvent.setup()
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    show()
    await user.click(await screen.findByRole("button", { name: "Copy link for Alpha share" }))
    await waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
    accountID = B
    await user.click(screen.getByRole("button", { name: "Copy link for Alpha share" }))
    await screen.findByText(/Account: Beta/)
    expect(clipboard).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/link"))).toHaveLength(1)
  })

  it("broadcasts only a secret-free logout invalidation", async () => {
    show()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Account" }))
    await user.click(screen.getByRole("menuitem", { name: "Log out" }))
    await waitFor(() =>
      expect(Channel.instances[0]?.postMessage).toHaveBeenCalledExactlyOnceWith("invalidate"),
    )
    expect(Channel.instances[0]?.name).toBe(accountChannel)
  })

  it.each(["verify", "passkey"] as const)(
    "does not finish %s after the account changes during its native prompt",
    async (operation) => {
      const prompt = deferred<never>()
      const start = operation === "verify" ? startAuthentication : startRegistration
      vi.mocked(start).mockReturnValueOnce(prompt.promise)
      if (operation === "verify")
        intercept = (path, _init, id) =>
          path === "account"
            ? Promise.resolve(json({ ...identity(id), verification_required: true }, id))
            : undefined
      show(operation === "verify" ? "/manage/api-keys" : "/account")
      if (operation === "verify") await createKey()
      else {
        const user = userEvent.setup()
        await user.type(await screen.findByLabelText("Passkey name"), "Device")
        await user.click(screen.getByRole("button", { name: "Add passkey" }))
      }
      await waitFor(() => expect(start).toHaveBeenCalledOnce())
      await switchAccount()
      expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalled()
      await act(async () => prompt.resolve({ id: "late" } as never))
      expect(fetchMock.mock.calls.some(([url]) => url === `/v1/auth/${operation}/finish`)).toBe(
        false,
      )
      expect(document.body).not.toHaveTextContent("Passkey added.")
    },
  )
})
