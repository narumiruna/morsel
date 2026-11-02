import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../App"
import { navigate } from "../navigation"
import { ThemeProvider } from "../theme"
import * as api from "./accountApi"
import type { OAuthGrant } from "./oauth"

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}))
const A = "10000000-0000-4000-8000-000000000001"
const B = "20000000-0000-4000-8000-000000000002"
const firstID = "30000000-0000-4000-8000-000000000003"
const secondID = "40000000-0000-4000-8000-000000000004"
const foreignID = "50000000-0000-4000-8000-000000000005"
const created = "2026-11-02T00:00:00Z"
const listPath = "account/oauth/grants"
const deletePath = `${listPath}/${firstID}`
const grant = (id: string, client: string): OAuthGrant => ({
  id,
  client_id: client,
  client_name: "Pi",
  resource: "https://morsel.example/mcp",
  scope: "mcp:shares offline_access",
  created_at: created,
  expires_at: "2026-12-02T00:00:00Z",
  revoked_at: null,
})
const identity = (id = A): api.Account => ({
  authenticated: true,
  setup_required: false,
  account_id: id,
  display_name: id === A ? "Alpha" : "Beta",
  csrf_token: `csrf-${id}`,
  verification_required: false,
})
class Channel {
  static latest: Channel
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage() {}
  close() {}
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
let grants: Record<string, OAuthGrant[]>
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let intercept: ((path: string, init?: RequestInit) => Promise<Response> | undefined) | undefined
const json = (body: unknown, id: string | null = account.account_id ?? A, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: id ? { "X-Morsel-Account-ID": id } : {},
  })
const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")
function show(strict = false) {
  window.history.replaceState({}, "", "/account")
  const app = (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  )
  return render(strict ? <StrictMode>{app}</StrictMode> : app)
}
const revokeButton = (id = firstID) => screen.getByRole("button", { name: `Revoke app Pi (${id})` })
async function confirm() {
  await userEvent.setup().click(await screen.findByRole("button", { name: "Confirm revoke app" }))
}
async function select(id = firstID) {
  await screen.findByRole("heading", { name: "Connected apps" })
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: `Revoke app Pi (${id})` }))
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
  grants = {
    [A]: [grant(firstID, "first-client"), grant(secondID, "second-client")],
    [B]: [grant(foreignID, "first-client")],
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
    if (path === "passkeys") return json([{ id: "first", name: "Device", created_at: created }])
    if (path === listPath) return json(grants[account.account_id ?? ""] ?? [])
    if (path.startsWith(`${listPath}/`) && init?.method === "DELETE") {
      const owned = grants[account.account_id ?? ""] ?? []
      const id = decodeURIComponent(path.slice(listPath.length + 1))
      if (!owned.some((item) => item.id === id))
        return json({ code: "not_found", message: "Not found." }, null, 404)
      grants[account.account_id ?? ""] = owned.map((item) =>
        item.id === id ? { ...item, revoked_at: created } : item,
      )
      return new Response(null, {
        status: 204,
        headers: { "X-Morsel-Account-ID": account.account_id ?? A },
      })
    }
    if (path.endsWith("/begin")) return json({ publicKey: {} })
    if (path.endsWith("/finish")) return json({})
    if (path === "auth/logout") return json({})
    throw new Error(`Unexpected request ${path}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

describe("connected apps", () => {
  it("lists same-name connections with distinct IDs, resource, scope, and revoked rows without mutations", async () => {
    grants[A]?.push({ ...grant("revoked-id", "revoked-client"), revoked_at: created })
    const { container } = show(true)
    await screen.findByText("revoked-client")
    for (const id of [firstID, secondID, "revoked-id"])
      expect(screen.getByText(id)).toBeInTheDocument()
    expect(screen.getAllByText("mcp:shares offline_access")).toHaveLength(3)
    expect(screen.getByText(/Created .*Revoked/)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Revoke app Pi (revoked-id)" }),
    ).not.toBeInTheDocument()
    expect(deletes()).toHaveLength(0)
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
  })

  it("confirms the selected connection, initially focuses Cancel, and returns focus without a request", async () => {
    show()
    await select(secondID)
    const confirmation = screen.getByRole("region", { name: "Revoke app access?" })
    expect(within(confirmation).getByText("second-client")).toBeInTheDocument()
    expect(within(confirmation).getByText(secondID)).toBeInTheDocument()
    expect(within(confirmation).queryByText("first-client")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()
    const before = fetchMock.mock.calls.length
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }))
    expect(revokeButton(secondID)).toHaveFocus()
    expect(fetchMock.mock.calls).toHaveLength(before)
    expect(deletes()).toHaveLength(0)
  })

  it("revokes only the chosen owned connection, displays the revoked row, and focuses the heading", async () => {
    show()
    await select(secondID)
    await confirm()
    await screen.findByText("App access revoked. Existing shares are unchanged.")
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Connected apps" })).toHaveFocus(),
    )
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0]?.[0]).toBe(`/v1/${listPath}/${secondID}`)
    expect(grants[A]?.find((item) => item.id === firstID)?.revoked_at).toBeNull()
    expect(grants[A]?.find((item) => item.id === secondID)?.revoked_at).toBe(created)
    expect(grants[B]?.[0]?.revoked_at).toBeNull()
    expect(revokeButton()).toBeEnabled()
    expect(
      screen.queryByRole("button", { name: `Revoke app Pi (${secondID})` }),
    ).not.toBeInTheDocument()
  })

  it.each([false, true, undefined])(
    "uses current CSRF and verification_required=%s from preflight",
    async (required) => {
      show()
      await select()
      account = { ...account, verification_required: required, csrf_token: "current-csrf" }
      await confirm()
      await screen.findByText("App access revoked. Existing shares are unchanged.")
      expect(deletes()[0]?.[1]?.headers).toHaveProperty("X-CSRF-Token", "current-csrf")
      expect(startAuthentication).toHaveBeenCalledTimes(required === false ? 0 : 1)
      expect(deletes()[0]?.[1]).toMatchObject({
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
      })
    },
  )

  it("retries an initial list failure with only GET", async () => {
    intercept = (path) => (path === listPath ? Promise.reject(new TypeError("network")) : undefined)
    show()
    await screen.findByText(/Could not load connected apps/)
    expect(screen.queryByText("No connected apps.")).not.toBeInTheDocument()
    const before = fetchMock.mock.calls.length
    intercept = undefined
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry connected apps" }))
    await screen.findByText("first-client")
    expect(fetchMock.mock.calls.slice(before).map(([url, init]) => [url, init?.method])).toEqual([
      [`/v1/${listPath}`, "GET"],
    ])
    expect(startAuthentication).not.toHaveBeenCalled()
  })

  it("shows an empty list", async () => {
    grants[A] = []
    show()
    await screen.findByText("No connected apps.")
    expect(deletes()).toHaveLength(0)
  })

  it("does not replay a failed revocation and retains confirmation for explicit retry", async () => {
    show()
    await select()
    intercept = (path) =>
      path === deletePath ? Promise.reject(new TypeError("network")) : undefined
    await confirm()
    await screen.findByText(/could not be completed/)
    expect(deletes()).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Confirm revoke app" })).toBeEnabled()
    intercept = undefined
    await confirm()
    await screen.findByText("App access revoked. Existing shares are unchanged.")
    expect(deletes()).toHaveLength(2)
  })

  it("keeps successful revocation separate from list failure; retry never replays DELETE", async () => {
    show()
    await select()
    intercept = (path) => (path === listPath ? Promise.reject(new TypeError("network")) : undefined)
    await confirm()
    await screen.findByText(/Could not load connected apps/)
    expect(
      screen.getByText("App access revoked. Existing shares are unchanged."),
    ).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Connected apps" })).toHaveFocus()
    expect(screen.queryByRole("button", { name: "Confirm revoke app" })).not.toBeInTheDocument()
    const before = fetchMock.mock.calls.length
    intercept = undefined
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry connected apps" }))
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Retry connected apps" }),
      ).not.toBeInTheDocument(),
    )
    expect(fetchMock.mock.calls.slice(before).map(([url, init]) => [url, init?.method])).toEqual([
      [`/v1/${listPath}`, "GET"],
    ])
    expect(deletes()).toHaveLength(1)
  })

  it("locks duplicate confirmation synchronously", async () => {
    show()
    await select()
    const pending = deferred<Response>()
    intercept = (path) => (path === deletePath ? pending.promise : undefined)
    const confirm = screen.getByRole("button", { name: "Confirm revoke app" })
    act(() => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(deletes()).toHaveLength(1))
    expect(confirm).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await act(async () => pending.reject(new TypeError("network")))
    await screen.findByText(/could not be completed/)
  })

  it.each(["passkey", "app"])(
    "uses the parent mutation lock while a %s operation is pending",
    async (operation) => {
      show()
      await select()
      const prompt = deferred<never>()
      const response = deferred<Response>()
      const user = userEvent.setup()
      if (operation === "passkey") {
        vi.mocked(startRegistration).mockReturnValueOnce(prompt.promise)
        await user.type(screen.getByLabelText("Passkey name"), "Backup")
        await user.click(screen.getByRole("button", { name: "Add passkey" }))
        await waitFor(() => expect(startRegistration).toHaveBeenCalledOnce())
        expect(screen.getByRole("button", { name: "Confirm revoke app" })).toBeDisabled()
        fireEvent.click(screen.getByRole("button", { name: "Confirm revoke app" }))
        expect(deletes()).toHaveLength(0)
        await act(async () => prompt.reject(new DOMException("cancel", "NotAllowedError")))
      } else {
        intercept = (path) => (path === deletePath ? response.promise : undefined)
        await confirm()
        await waitFor(() => expect(deletes()).toHaveLength(1))
        const button = screen.getByRole("button", { name: "Add passkey" })
        expect(button).toBeDisabled()
        fireEvent.submit(button.closest("form") as HTMLFormElement)
        expect(startRegistration).not.toHaveBeenCalled()
        await act(async () => response.reject(new TypeError("network")))
      }
      await screen.findByText(
        operation === "passkey" ? /cancelled or timed out/ : /could not be completed/,
      )
    },
  )

  it("rejects a silent cookie change at preflight even when both accounts have the same app name", async () => {
    show()
    await select()
    account = { ...identity(B), verification_required: true }
    await confirm()
    await screen.findByText("Account: Beta")
    await screen.findByText(foreignID)
    expect(screen.queryByText(firstID)).not.toBeInTheDocument()
    expect(deletes()).toHaveLength(0)
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Confirm revoke app" })).not.toBeInTheDocument()
  })

  it("cannot revoke another owner's ID if the cookie changes after preflight", async () => {
    show()
    await select()
    intercept = (path) => {
      if (path !== "account") return
      account = identity(B)
      intercept = undefined
      return Promise.resolve(json(identity(A), A))
    }
    await confirm()
    await screen.findByText("Not found.")
    expect(grants[A]?.[0]?.revoked_at).toBeNull()
    expect(grants[B]?.[0]?.revoked_at).toBeNull()
    expect(deletes()).toHaveLength(1)
    expect(
      screen.queryByText("App access revoked. Existing shares are unchanged."),
    ).not.toBeInTheDocument()
  })

  it.each(["GET", "DELETE"].flatMap((method) => [null, B].map((marker) => ({ method, marker }))))(
    "rejects $method responses with account marker $marker",
    async ({ method, marker }) => {
      if (method === "DELETE") {
        show()
        await select()
      }
      let captured = false
      intercept = (path, init) => {
        if (
          captured ||
          path !== (method === "GET" ? listPath : deletePath) ||
          init?.method !== method
        )
          return
        captured = true
        account = identity(B)
        return Promise.resolve(
          method === "GET"
            ? json([grant("PRIVATE-FOREIGN-GRANT", "PRIVATE-FOREIGN-CLIENT")], marker)
            : new Response(null, {
                status: 204,
                headers: marker ? { "X-Morsel-Account-ID": marker } : {},
              }),
        )
      }
      if (method === "GET") show()
      else await confirm()
      await screen.findByText("Account: Beta")
      expect(document.body).not.toHaveTextContent("PRIVATE-FOREIGN")
      expect(
        screen.queryByText("App access revoked. Existing shares are unchanged."),
      ).not.toBeInTheDocument()
    },
  )

  it.each(["focus", "broadcast"] as const)(
    "aborts passkey verification after %s account change without DELETE",
    async (event) => {
      account.verification_required = true
      const prompt = deferred<never>()
      vi.mocked(startAuthentication).mockReturnValueOnce(prompt.promise)
      show()
      await select()
      await confirm()
      await waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce())
      await change(event)
      expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalled()
      await act(async () => prompt.resolve({ id: "late" } as never))
      expect(fetchMock.mock.calls.some(([url]) => url === "/v1/auth/verify/finish")).toBe(false)
      expect(deletes()).toHaveLength(0)
    },
  )

  it.each(
    ["GET", "DELETE"].flatMap((method) =>
      ["focus", "broadcast", "unmount"].map((event) => ({ method, event })),
    ),
  )("aborts $method on $event and ignores its late response", async ({ method, event }) => {
    if (method === "DELETE") {
      show()
      await select()
    }
    const pending = deferred<Response>()
    let signal: AbortSignal | null | undefined
    let captured = false
    intercept = (path, init) => {
      if (
        captured ||
        path !== (method === "GET" ? listPath : deletePath) ||
        init?.method !== method
      )
        return
      captured = true
      signal = init.signal
      return pending.promise
    }
    const page = method === "GET" ? show() : undefined
    if (method === "DELETE") await confirm()
    await waitFor(() => expect(captured).toBe(true))
    if (event === "unmount") {
      if (page) page.unmount()
      else act(() => navigate("/"))
    } else await change(event as "focus" | "broadcast")
    expect(signal?.aborted).toBe(true)
    await act(async () =>
      pending.resolve(
        method === "GET"
          ? json([grant("PRIVATE-LATE-GRANT", "PRIVATE-LATE-CLIENT")], A)
          : new Response(null, { status: 204, headers: { "X-Morsel-Account-ID": A } }),
      ),
    )
    expect(document.body).not.toHaveTextContent("PRIVATE-LATE")
    expect(
      screen.queryByText("App access revoked. Existing shares are unchanged."),
    ).not.toBeInTheDocument()
  })

  it("checks identity after delayed list response bodies", async () => {
    const body = deferred<unknown>()
    let captured = false
    intercept = (path) => {
      if (captured || path !== listPath) return
      captured = true
      const response = json({})
      vi.spyOn(response, "json").mockReturnValueOnce(body.promise)
      return Promise.resolve(response)
    }
    show()
    await waitFor(() => expect(captured).toBe(true))
    await change("broadcast")
    await act(async () => body.resolve([grant("PRIVATE-LATE-GRANT", "PRIVATE-LATE-CLIENT")]))
    expect(document.body).not.toHaveTextContent("PRIVATE-LATE")
  })

  it.each(["preflight", "response"])(
    "checks identity in the microtask before %s continuation",
    async (stage) => {
      show()
      await select()
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
            if (!captured && path === (stage === "preflight" ? "account" : deletePath)) {
              captured = true
              queueMicrotask(() => {
                account = identity(B)
                Channel.latest.onmessage?.({ data: "invalidate" })
              })
            }
            return value
          },
        )
      try {
        await confirm()
        await screen.findByText("Account: Beta")
        expect(captured).toBe(true)
        expect(deletes()).toHaveLength(stage === "preflight" ? 0 : 1)
        expect(
          screen.queryByText("App access revoked. Existing shares are unchanged."),
        ).not.toBeInTheDocument()
      } finally {
        spy.mockRestore()
      }
    },
  )

  it("disables revoke in browsers without passkey support", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false)
    show()
    await screen.findByText(firstID)
    expect(revokeButton()).toBeDisabled()
    expect(deletes()).toHaveLength(0)
  })
})
