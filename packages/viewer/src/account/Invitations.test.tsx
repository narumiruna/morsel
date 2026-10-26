import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../App"
import { navigate } from "../navigation"
import { ThemeProvider } from "../theme"
import * as api from "./accountApi"

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}))
class Channel {
  static latest: Channel
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor() {
    Channel.latest = this
  }
  postMessage() {}
  close() {}
}
const A = "10000000-0000-4000-8000-000000000001"
const B = "20000000-0000-4000-8000-000000000002"
const token = "A".repeat(43)
const link = `https://morsel.example/invite#token=${token}`
const result = () => ({
  invitation_url: link,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
})
let account: api.Account
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let intercept: ((path: string, init?: RequestInit) => Promise<Response> | undefined) | undefined
const json = (body: unknown, id = account.account_id ?? A, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "X-Morsel-Account-ID": id } })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function show(path = "/manage/invitations", strict = false) {
  window.history.replaceState({}, "", path)
  const app = (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  )
  return render(strict ? <StrictMode>{app}</StrictMode> : app)
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")
async function create() {
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "Create invitation link" }))
}
async function recheck() {
  act(() => fireEvent(window, new Event("focus")))
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Create invitation link" }),
    ).not.toBeInTheDocument(),
  )
}
beforeEach(() => {
  account = {
    authenticated: true,
    setup_required: false,
    account_id: A,
    display_name: "Alpha",
    role: "admin",
    csrf_token: "csrf",
    verification_required: false,
  }
  intercept = undefined
  vi.stubGlobal("BroadcastChannel", Channel)
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true)
  vi.mocked(startAuthentication).mockResolvedValue({ id: "credential" } as never)
  vi.mocked(startRegistration).mockResolvedValue({ id: "credential" } as never)
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).replace("/v1/", "")
    const pending = intercept?.(path, init)
    if (pending) return pending
    if (path === "account") return json(account)
    if (path === "account/invitations") return json(result(), account.account_id, 201)
    if (path === "api-keys" || path === "passkeys") return json([])
    if (path.startsWith("account/shares?")) return json({ items: [], matching_count: 0 })
    if (path === "auth/logout") {
      account = { authenticated: false, setup_required: false }
      return json({})
    }
    if (path.endsWith("/begin")) return json({ publicKey: {} })
    if (path.endsWith("/finish")) return json({})
    throw new Error(`Unexpected request ${path}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

describe("admin invitations", () => {
  it.each(["user", undefined, "unknown"])("denies missing and non-admin role %s", async (role) => {
    account.role = role as api.Account["role"]
    show()
    await screen.findByText(/Access denied/)
    expect(screen.queryByRole("link", { name: "Invitations" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Create invitation link" })).not.toBeInTheDocument()
    expect(posts()).toHaveLength(0)
  })

  it("issues only on explicit action, uses empty JSON, warns, copies, and requires dismissal", async () => {
    const user = userEvent.setup()
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    show(undefined, true)
    await screen.findByRole("link", { name: "Invitations" })
    expect(posts()).toHaveLength(0)
    await create()
    expect(await screen.findByLabelText("Invitation link")).toHaveValue(link)
    expect(posts()).toHaveLength(1)
    expect(posts()[0]?.[1]?.body).toBe("{}")
    expect(posts()[0]?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf" })
    expect(screen.queryByRole("button", { name: "Create invitation link" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("link", { name: "Security" }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Discard this invitation link?"))
    expect(window.location.pathname).toBe("/manage/invitations")
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false)
    await user.click(screen.getByRole("button", { name: "Copy link" }))
    await screen.findByText("Invitation link copied.")
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(link)
    await user.click(screen.getByRole("button", { name: "Dismiss invitation link" }))
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true)
    expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument()
    expect(JSON.stringify(window.history.state)).not.toContain(token)
    expect(window.location.href).not.toContain(token)
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(token)
    confirm.mockRestore()
  })

  it("shows manual-copy fallback and only reports copy success after settlement", async () => {
    const user = userEvent.setup()
    const pending = deferred<void>()
    const clipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValueOnce(pending.promise)
    show()
    await create()
    await user.click(await screen.findByRole("button", { name: "Copy link" }))
    expect(screen.queryByText("Invitation link copied.")).not.toBeInTheDocument()
    await act(async () => pending.reject(new Error("denied")))
    await screen.findByText(/Could not copy link/)
    expect(screen.getByLabelText("Invitation link")).toHaveValue(link)
    clipboard.mockResolvedValueOnce(undefined)
    await user.click(screen.getByRole("button", { name: "Copy link" }))
    await screen.findByText("Invitation link copied.")
    expect(posts()).toHaveLength(1)
  })

  it("does not replay a failed or uncertain mutation; retry is explicit and independent", async () => {
    let attempts = 0
    intercept = (path) => {
      if (path !== "account/invitations") return
      return ++attempts === 1
        ? Promise.reject(new TypeError("network"))
        : Promise.resolve(json(result()))
    }
    show()
    await create()
    await screen.findByText(/could not be completed/)
    expect(attempts).toBe(1)
    await create()
    await screen.findByLabelText("Invitation link")
    expect(attempts).toBe(2)
  })

  it.each(
    ["role", "identity"].flatMap((kind) =>
      ["success", "network", "unauthorized", "server"].map((outcome) => ({ kind, outcome })),
    ),
  )("discards delayed $outcome after $kind loss", async ({ kind, outcome }) => {
    const pending = deferred<Response>()
    intercept = (path) => (path === "account/invitations" ? pending.promise : undefined)
    show()
    await create()
    await waitFor(() => expect(posts()).toHaveLength(1))
    if (kind === "role") account = { ...account, role: "user" }
    else account = { ...account, account_id: B, display_name: "Beta", role: "user" }
    await recheck()
    await screen.findByText(/Access denied/)
    await act(async () => {
      if (outcome === "network") pending.reject(new TypeError("obsolete network error"))
      else
        pending.resolve(
          outcome === "success"
            ? json(result(), A)
            : json({ message: "obsolete failure" }, A, outcome === "unauthorized" ? 401 : 503),
        )
    })
    expect(screen.getByText(/Access denied/)).toBeInTheDocument()
    expect(screen.queryByText("obsolete failure")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument()
    expect(screen.queryByText(/copied/)).not.toBeInTheDocument()
    expect(posts()).toHaveLength(1)
  })

  it("clears an existing link on same-account role loss and does not restore it on promotion", async () => {
    show()
    await create()
    await screen.findByLabelText("Invitation link")
    account = { ...account, role: "user" }
    await recheck()
    await screen.findByText(/Access denied/)
    expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument()
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true)
    account = { ...account, role: "admin" }
    act(() => fireEvent(window, new Event("focus")))
    await screen.findByRole("button", { name: "Create invitation link" })
    expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument()
  })

  it.each(["create", "copy"])(
    "checks identity immediately after awaited preflight before %s",
    async (kind) => {
      const user = userEvent.setup()
      const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
      show()
      await screen.findByRole("button", { name: "Create invitation link" })
      if (kind === "copy") {
        await create()
        await screen.findByLabelText("Invitation link")
      }
      const original = api.accountRequest
      let captured = false
      const spy = vi
        .spyOn(api, "accountRequest")
        .mockImplementation(
          async <T,>(
            path: string,
            options: Parameters<typeof api.accountRequest>[1],
          ): Promise<T> => {
            const value = await original<T>(path, options)
            if (path === "account" && !captured) {
              captured = true
              queueMicrotask(() =>
                queueMicrotask(() => {
                  // Refresh has committed its response. Invalidate before the action resumes,
                  // while React has not yet cleaned up the old component.
                  account = { ...account, account_id: B, display_name: "Beta", role: "user" }
                  Channel.latest.onmessage?.({ data: "invalidate" })
                }),
              )
            }
            return value
          },
        )
      const count = posts().length
      try {
        await user.click(
          screen.getByRole("button", {
            name: kind === "copy" ? "Copy link" : "Create invitation link",
          }),
        )
        await waitFor(() => expect(captured).toBe(true))
        await screen.findByText(/Access denied/)
        expect(posts()).toHaveLength(count)
        expect(clipboard).not.toHaveBeenCalled()
        expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument()
      } finally {
        spy.mockRestore()
      }
    },
  )

  it("discards a response invalidated between the request helper and the action continuation", async () => {
    show()
    await screen.findByRole("button", { name: "Create invitation link" })
    const original = api.accountRequest
    const spy = vi
      .spyOn(api, "accountRequest")
      .mockImplementation(
        async <T,>(path: string, options: Parameters<typeof api.accountRequest>[1]): Promise<T> => {
          const value = await original<T>(path, options)
          if (path === "account/invitations")
            queueMicrotask(() => {
              account = { ...account, role: "user" }
              Channel.latest.onmessage?.({ data: "invalidate" })
            })
          return value
        },
      )
    try {
      await create()
      await screen.findByText(/Access denied/)
      expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument()
      expect(posts()).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it.each(["create", "copy"])(
    "cancels pending %s synchronously when logout starts",
    async (kind) => {
      const user = userEvent.setup()
      let clipboardContent = "sentinel"
      const clipboard = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockImplementation(async (value) => {
          clipboardContent = value
        })
      show()
      await screen.findByRole("button", { name: "Create invitation link" })
      if (kind === "copy") {
        await create()
        await screen.findByLabelText("Invitation link")
      }
      const pending = deferred<Response>()
      let captured = false
      intercept = (path) => {
        if (path !== "account" || captured) return
        captured = true
        return pending.promise
      }
      const before = posts().length
      await user.click(
        screen.getByRole("button", {
          name: kind === "copy" ? "Copy link" : "Create invitation link",
        }),
      )
      await waitFor(() => expect(captured).toBe(true))
      const heldAccount = { ...account }
      await user.click(screen.getByRole("button", { name: "Account" }))
      await user.click(screen.getByRole("menuitem", { name: "Log out" }))
      await screen.findByRole("heading", { name: "Sign in" })
      await act(async () => pending.resolve(json(heldAccount, A)))
      expect(clipboard).not.toHaveBeenCalled()
      expect(clipboardContent).toBe("sentinel")
      expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument()
      expect(posts()).toHaveLength(before + 1)
    },
  )

  it("rejects same-account role loss at mutation preflight without issuance or verification", async () => {
    show()
    await screen.findByRole("button", { name: "Create invitation link" })
    account = { ...account, role: "user", verification_required: true }
    await create()
    await screen.findByText(/Access denied/)
    expect(posts()).toHaveLength(0)
    expect(startAuthentication).not.toHaveBeenCalled()
  })

  it("rejects silent cookie switches before copying and leaves the clipboard sentinel unchanged", async () => {
    const user = userEvent.setup()
    let content = "sentinel"
    const clipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockImplementation(async (value) => {
        content = value
      })
    show()
    await create()
    await screen.findByLabelText("Invitation link")
    account = { ...account, account_id: B, display_name: "Beta", role: "user" }
    await user.click(screen.getByRole("button", { name: "Copy link" }))
    await screen.findByText(/Access denied/)
    expect(clipboard).not.toHaveBeenCalled()
    expect(content).toBe("sentinel")
  })

  it.each(["success", "failure"])(
    "ignores delayed clipboard %s after role loss without reviving account or secret state",
    async (outcome) => {
      const user = userEvent.setup()
      const pending = deferred<void>()
      vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(pending.promise)
      show()
      await create()
      await user.click(await screen.findByRole("button", { name: "Copy link" }))
      account = { ...account, role: "user" }
      await recheck()
      await screen.findByText(/Access denied/)
      await act(async () => {
        if (outcome === "failure") pending.reject(new Error("late"))
        else pending.resolve()
      })
      expect(screen.queryByText("Invitation link copied.")).not.toBeInTheDocument()
      expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument()
      expect(screen.queryByText(/Could not copy/)).not.toBeInTheDocument()
    },
  )

  it("does not create after a cancelled verification and prevents double submission", async () => {
    account.verification_required = true
    const pending = deferred<never>()
    vi.mocked(startAuthentication).mockReturnValueOnce(pending.promise)
    show()
    await create()
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("button", { name: "Create invitation link" }))
    expect(startAuthentication).toHaveBeenCalledOnce()
    await act(async () => pending.reject(new DOMException("cancelled", "NotAllowedError")))
    await screen.findByText(/cancelled or timed out/)
    expect(fetchMock.mock.calls.some(([url]) => url === "/v1/account/invitations")).toBe(false)
  })

  it("cancels section-exit work and does not revive a late response or automatically issue another link", async () => {
    const pending = deferred<Response>()
    intercept = (path) => (path === "account/invitations" ? pending.promise : undefined)
    show()
    await create()
    await waitFor(() => expect(posts()).toHaveLength(1))
    await userEvent.setup().click(screen.getByRole("link", { name: "Security" }))
    await screen.findByRole("heading", { name: "Passkeys" })
    await act(async () => pending.resolve(json(result(), A)))
    await userEvent.setup().click(screen.getByRole("link", { name: "Invitations" }))
    await screen.findByRole("button", { name: "Create invitation link" })
    expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument()
    expect(posts()).toHaveLength(1)
  })

  it("disables copy for expired links and permits new creation only after dismissal", async () => {
    intercept = (path) =>
      path === "account/invitations"
        ? Promise.resolve(
            json({ ...result(), expires_at: new Date(Date.now() - 1000).toISOString() }),
          )
        : undefined
    show()
    await create()
    await screen.findByText(/link has expired/)
    expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled()
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss invitation link" }))
    expect(screen.getByRole("button", { name: "Create invitation link" })).toBeEnabled()
  })
})

describe("recipient invitation intake", () => {
  it("prefills only in flow memory under StrictMode and never submits on open", async () => {
    account = { authenticated: false, setup_required: false }
    const storage = vi.spyOn(Storage.prototype, "setItem")
    show(`/invite#token=${token}`, true)
    expect(window.location.hash).toBe("")
    expect(await screen.findByLabelText("Invitation token")).toHaveValue(token)
    expect(posts()).toHaveLength(0)
    expect(startRegistration).not.toHaveBeenCalled()
    expect(storage.mock.calls.some((call) => JSON.stringify(call).includes(token))).toBe(false)
    expect(
      fetchMock.mock.calls.every(
        ([url, init]) =>
          !String(url).includes(token) && !JSON.stringify(init?.headers).includes(token),
      ),
    ).toBe(true)
    expect(JSON.stringify(window.history.state)).not.toContain(token)
    act(() => navigate("/"))
    act(() => navigate("/invite"))
    expect(await screen.findByLabelText("Invitation token")).toHaveValue("")
    storage.mockRestore()
  })

  it("discards signed-in links and does not retain them across session expiration", async () => {
    show(`/invite#token=${token}`, true)
    await screen.findByText(/use a private window/)
    expect(window.location.pathname).toBe("/invite")
    expect(window.location.hash).toBe("")
    expect(screen.queryByLabelText("Invitation token")).not.toBeInTheDocument()
    expect(posts()).toHaveLength(0)
    account = { authenticated: false, setup_required: false }
    act(() => fireEvent(window, new Event("focus")))
    expect(await screen.findByLabelText("Invitation token")).toHaveValue("")
    expect(posts()).toHaveLength(0)
  })

  it("takes same-route arrivals, clears on submission/cancel, and never auto-replays", async () => {
    account = { authenticated: false, setup_required: false }
    vi.mocked(startRegistration).mockRejectedValueOnce(
      new DOMException("cancel", "NotAllowedError"),
    )
    show("/invite")
    await screen.findByLabelText("Invitation token")
    act(() => {
      window.history.pushState({}, "", `/invite#token=${token}`)
      fireEvent(window, new HashChangeEvent("hashchange"))
    })
    expect(screen.getByLabelText("Invitation token")).toHaveValue(token)
    expect(window.location.hash).toBe("")
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Account name"), "Recipient")
    await user.type(screen.getByLabelText("Passkey name"), "Device")
    await user.click(screen.getByRole("button", { name: "Create account" }))
    await screen.findByText(/cancelled or timed out/)
    expect(screen.getByLabelText("Invitation token")).toHaveValue("")
    expect(posts()).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/finish"))).toBe(false)
  })

  it("does not retain a fragment token on a same-route clean history arrival", async () => {
    account = { authenticated: false, setup_required: false }
    show(`/invite#token=${token}`)
    expect(await screen.findByLabelText("Invitation token")).toHaveValue(token)
    act(() => {
      window.history.replaceState({ morselIndex: 0 }, "", "/invite")
      fireEvent(window, new PopStateEvent("popstate"))
    })
    expect(screen.getByLabelText("Invitation token")).toHaveValue("")
    expect(posts()).toHaveLength(0)
  })

  it.each(["invalid", "expired", "already used"])(
    "clears the token after a generic %s grant response without replay",
    async () => {
      account = { authenticated: false, setup_required: false }
      intercept = (path) =>
        path === "auth/invite/begin"
          ? Promise.resolve(
              json({ code: "invalid_grant", message: "The grant is invalid or expired." }, A, 400),
            )
          : undefined
      show(`/invite#token=${token}`)
      const user = userEvent.setup()
      await user.type(await screen.findByLabelText("Account name"), "Recipient")
      await user.type(screen.getByLabelText("Passkey name"), "Device")
      await user.click(screen.getByRole("button", { name: "Create account" }))
      await screen.findByText("The grant is invalid or expired.")
      expect(screen.getByLabelText("Invitation token")).toHaveValue("")
      expect(posts()).toHaveLength(1)
      expect(startRegistration).not.toHaveBeenCalled()
    },
  )

  it("shows signed-in instructions after a sign_out_required response without retrying", async () => {
    account = { authenticated: false, setup_required: false }
    intercept = (path) => {
      if (path !== "auth/invite/begin") return
      account = {
        authenticated: true,
        setup_required: false,
        account_id: A,
        display_name: "Alpha",
        role: "admin",
      }
      return Promise.resolve(
        json({ code: "sign_out_required", message: "Sign out before registering." }, A, 409),
      )
    }
    show(`/invite#token=${token}`)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Account name"), "Recipient")
    await user.type(screen.getByLabelText("Passkey name"), "Device")
    await user.click(screen.getByRole("button", { name: "Create account" }))
    await screen.findByText(/use a private window/)
    expect(posts()).toHaveLength(1)
    expect(startRegistration).not.toHaveBeenCalled()
  })
})
