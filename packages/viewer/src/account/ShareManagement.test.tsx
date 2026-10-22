import {
  browserSupportsWebAuthn,
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AccountPage } from "../pages/AccountPage"
import { ThemeProvider } from "../theme"
import type { Account } from "./accountApi"
import type { ShareDetail, ShareStatus } from "./ShareManagement"

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}))

const created = "2026-10-21T10:00:00Z"
const credential = { id: "credential", response: {} }
const firstID = "a0000000-0000-4000-8000-000000000001"
let shares: ShareDetail[]
let account: Account
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let intercept: ((path: string, init?: RequestInit) => Promise<Response> | undefined) | undefined

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

function makeShare(
  id = firstID,
  label = "Historical share",
  status: ShareStatus = "active",
): ShareDetail {
  return {
    id,
    label,
    status,
    created_at: created,
    expires_at: null,
    max_views: null,
    view_count: 3,
    revoked_at: status === "revoked" ? created : null,
    content:
      "# Private Markdown\n\n**Owner content**\n\n<script>alert('unsafe')</script>\n\n[bad](javascript:alert(1))",
  }
}

function requests(path: string, method = "GET") {
  return fetchMock.mock.calls.filter(
    ([url, init]) => url === `/v1/${path}` && init?.method === method,
  )
}

function managementRequests() {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/v1/account/shares"))
}

async function showPage(strict = false) {
  const page = (
    <ThemeProvider>
      <AccountPage />
    </ThemeProvider>
  )
  const result = render(strict ? <StrictMode>{page}</StrictMode> : page)
  await screen.findByRole("heading", { name: "Shares" })
  return result
}

async function viewShare(label = "Historical share") {
  await userEvent.setup().click(await screen.findByRole("button", { name: `View share ${label}` }))
  return screen.findByRole("region", { name: `Share details: ${label}` })
}

beforeEach(() => {
  shares = [makeShare()]
  account = {
    setup_required: false,
    authenticated: true,
    csrf_token: "csrf",
    verification_required: true,
  }
  intercept = undefined
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true)
  vi.mocked(startAuthentication).mockResolvedValue(credential as never)
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url).replace("/v1/", "")
    const intercepted = intercept?.(path, init)
    if (intercepted) return intercepted
    if (path === "account") return json(account)
    if (path === "passkeys") return json([{ id: "passkey", name: "Laptop", created_at: created }])
    if (path === "api-keys") return json([])
    if (path === "auth/verify/begin") return json({ publicKey: { challenge: "test" } })
    if (path === "auth/verify/finish") return json({})
    if (path === "auth/logout") return new Response(null, { status: 204 })
    if (path.startsWith("account/shares?")) {
      const filter = new URLSearchParams(path.split("?")[1]).get("status")
      const items = shares
        .filter((share) => filter === "all" || filter === share.status)
        .map(({ content: _content, ...metadata }) => metadata)
      return json({ items })
    }
    if (path.startsWith("account/shares/")) {
      const share = shares.find(
        (item) => item.id === decodeURIComponent(path.slice("account/shares/".length)),
      )
      if (!share) return json({ message: "Share not found." }, 404)
      if (init?.method === "DELETE") {
        share.revoked_at = created
        share.status = "revoked"
        return new Response(null, { status: 204 })
      }
      return json(share)
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

describe("account share management", () => {
  it("shows server labels, administrative metadata, status snapshots, and all-share scope accessibly", async () => {
    shares = [
      makeShare(),
      makeShare("second", "First non-empty line", "expired"),
      makeShare("third", "Untitled", "revoked"),
      makeShare("fourth", "x".repeat(80), "view_limit_exhausted"),
      makeShare("fifth", "<img src=x onerror=alert(1)>"),
    ]
    shares[1] = {
      ...makeShare("second", "First non-empty line", "expired"),
      expires_at: created,
      max_views: 4,
    }
    const { container } = await showPage(true)
    const list = await screen.findByRole("list", { name: "Share history" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(5)
    for (const label of shares.map((share) => share.label))
      expect(within(list).getByRole("button", { name: `View share ${label}` })).toBeEnabled()
    expect(within(list).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument()
    expect(list.querySelector("img")).toBeNull()
    expect(within(list).getByText("Expired", { selector: "dd" })).toBeInTheDocument()
    expect(within(list).getByText("View limit exhausted", { selector: "dd" })).toBeInTheDocument()
    expect(within(list).getByText(firstID)).toBeInTheDocument()
    expect(within(list).getAllByText("Unlimited").length).toBeGreaterThan(0)
    expect(within(list).getByText("4", { selector: "dd" })).toBeInTheDocument()
    expect(screen.getByText(/including shares created before account setup/)).toBeInTheDocument()
    expect(screen.getByText(/snapshots/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Revoke share Untitled" })).not.toBeInTheDocument()
    expect(
      managementRequests().every(
        ([, init]) => init?.cache === "no-store" && init.credentials === "same-origin",
      ),
    ).toBe(true)
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
  })

  it.each(["active", "revoked", "expired", "view_limit_exhausted"] as const)(
    "filters %s and reads unavailable content without public consuming requests",
    async (status) => {
      shares = [
        makeShare(firstID, "Unavailable", status),
        makeShare("other", "Other", status === "active" ? "expired" : "active"),
      ]
      await showPage()
      await userEvent
        .setup()
        .selectOptions(screen.getByRole("combobox", { name: "Share status" }), status)
      await screen.findByRole("button", { name: "View share Unavailable" })
      expect(screen.queryByRole("button", { name: "View share Other" })).not.toBeInTheDocument()
      const region = await viewShare("Unavailable")
      await within(region).findByRole("heading", { name: "Private Markdown" })
      expect(within(region).getByText("Owner content").tagName).toBe("STRONG")
      expect(region.querySelector("script")).toBeNull()
      expect(within(region).getByText("bad")).not.toHaveAttribute(
        "href",
        expect.stringContaining("javascript:"),
      )
      expect(
        within(region).getByText(/original public URL cannot be recovered/),
      ).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /copy.*(url|link)/i })).not.toBeInTheDocument()
      expect(shares[0]?.view_count).toBe(3)
      expect(requests(`account/shares/${firstID}`)).toHaveLength(1)
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/v1/shares"))).toBe(false)
    },
  )

  it("paginates with opaque cursors, supports previous, and resets cursor history on a filter change", async () => {
    intercept = (path) => {
      if (!path.startsWith("account/shares?")) return
      const params = new URLSearchParams(path.split("?")[1])
      expect(params.get("limit")).toBe("25")
      const next = params.get("cursor")
      if (params.get("status") !== "all") {
        expect(next).toBeNull()
        return Promise.resolve(json({ items: [] }))
      }
      return Promise.resolve(
        next
          ? json({ items: [makeShare("older", "Older share")] })
          : json({ items: [shares[0]], next_cursor: "opaque/+=" }),
      )
    }
    await showPage()
    const user = userEvent.setup()
    await screen.findByRole("button", { name: "View share Historical share" })
    expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Next shares" }))
    await screen.findByRole("button", { name: "View share Older share" })
    expect(screen.getByRole("button", { name: "Next shares" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Previous shares" }))
    await screen.findByRole("button", { name: "View share Historical share" })
    await user.click(screen.getByRole("button", { name: "Next shares" }))
    await screen.findByRole("button", { name: "View share Older share" })
    await user.selectOptions(screen.getByLabelText("Share status"), "expired")
    await screen.findByText("No shares match this status.")
    expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText("Share status"), "all")
    await screen.findByRole("button", { name: "View share Historical share" })
    expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
  })

  it("requires explicit confirmation, permits cancellation, verifies with fresh state and refreshes list and detail", async () => {
    await showPage()
    const region = await viewShare()
    await within(region).findByRole("heading", { name: "Private Markdown" })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Revoke share Historical share" }))
    expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(0)
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel revocation" }))
    expect(screen.queryByRole("button", { name: "Confirm revocation" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Revoke share Historical share" }))
    account = { ...account, csrf_token: "fresh-csrf" }
    await user.click(screen.getByRole("button", { name: "Confirm revocation" }))
    await screen.findByText(/Share revoked\. Copies/)
    await waitFor(() => expect(requests(`account/shares/${firstID}`)).toHaveLength(2))
    await within(region).findByText("Revoked", { selector: "dd" })
    expect(
      within(await screen.findByRole("list", { name: "Share history" })).getByText("Revoked", {
        selector: "dd",
      }),
    ).toBeInTheDocument()
    const deletion = requests(`account/shares/${firstID}`, "DELETE")
    expect(deletion).toHaveLength(1)
    expect(deletion[0]?.[1]?.headers).toHaveProperty("X-CSRF-Token", "fresh-csrf")
    expect(requests("auth/verify/finish", "POST")).toHaveLength(1)
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls.indexOf("/v1/auth/verify/finish")).toBeLessThan(
      fetchMock.mock.calls.findIndex(([, init]) => init?.method === "DELETE"),
    )
    expect(screen.queryByRole("button", { name: "Confirm revocation" })).not.toBeInTheDocument()
  })

  it("skips verification only on fresh server state and removes revoked rows from an active filter", async () => {
    await showPage()
    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText("Share status"), "active")
    await user.click(await screen.findByRole("button", { name: "Revoke share Historical share" }))
    account = { ...account, verification_required: false }
    await user.click(screen.getByRole("button", { name: "Confirm revocation" }))
    await screen.findByText("No shares match this status.")
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(1)
  })

  it("handles cancelled verification, disables duplicate confirmation, and allows retry or cancel", async () => {
    const pending = deferred<never>()
    vi.mocked(startAuthentication).mockReturnValueOnce(pending.promise)
    await showPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Revoke share Historical share" }))
    const confirm = screen.getByRole("button", { name: "Confirm revocation" })
    await user.click(confirm)
    expect(confirm).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel revocation" })).toBeDisabled()
    fireEvent.click(confirm)
    expect(startAuthentication).toHaveBeenCalledOnce()
    // Reject the prompt rather than accepting it.
    await act(async () => {
      pending.reject(new DOMException("cancelled", "NotAllowedError"))
    })
    await screen.findByText(/cancelled or timed out/)
    expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(0)
    await waitFor(() => expect(confirm).toBeEnabled())
    await user.click(confirm)
    await screen.findByText(/Share revoked\. Copies/)
    expect(startAuthentication).toHaveBeenCalledTimes(2)
    expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(1)
  })

  it.each([403, 404, 500])(
    "reports a %s revocation failure without automatic retry and keeps confirmation cancellable",
    async (status) => {
      await showPage()
      intercept = (path, init) =>
        path.startsWith("account/shares/") && init?.method === "DELETE"
          ? Promise.resolve(json({ message: "Cannot revoke share." }, status))
          : undefined
      const user = userEvent.setup()
      await user.click(await screen.findByRole("button", { name: "Revoke share Historical share" }))
      await user.click(screen.getByRole("button", { name: "Confirm revocation" }))
      await screen.findByText(status === 403 ? /Authorization expired/ : "Cannot revoke share.")
      expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(1)
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Cancel revocation" })).toBeEnabled(),
      )
      await user.click(screen.getByRole("button", { name: "Cancel revocation" }))
      expect(screen.queryByRole("button", { name: "Confirm revocation" })).not.toBeInTheDocument()
    },
  )

  it("shows loading, empty and failed lists and details with explicit retries and close", async () => {
    const pending = deferred<Response>()
    intercept = (path) => (path.startsWith("account/shares?") ? pending.promise : undefined)
    await showPage()
    expect(screen.getByText("Loading shares…")).toBeInTheDocument()
    await act(async () => pending.resolve(json({ message: "List unavailable." }, 500)))
    await screen.findByText("List unavailable.")
    intercept = undefined
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Retry shares" }))
    intercept = (path) =>
      path === `account/shares/${firstID}`
        ? Promise.resolve(json({ message: "Share not found." }, 404))
        : undefined
    const region = await viewShare()
    await within(region).findByText("Share not found.")
    intercept = undefined
    await user.click(within(region).getByRole("button", { name: "Retry share details" }))
    await within(region).findByRole("heading", { name: "Private Markdown" })
    await user.click(screen.getByRole("button", { name: "Close share details" }))
    expect(screen.queryByRole("heading", { name: "Private Markdown" })).not.toBeInTheDocument()
    shares = []
    await user.click(screen.getByRole("button", { name: "Refresh shares" }))
    await screen.findByText("No shares yet.")
  })

  it.each([200, 401])(
    "aborts obsolete lists on filtering and ignores a late %s response",
    async (status) => {
      const pending = deferred<Response>()
      let oldSignal: AbortSignal | null | undefined
      intercept = (path, init) => {
        if (!path.startsWith("account/shares?status=all")) return
        oldSignal = init?.signal
        return pending.promise
      }
      await showPage()
      await userEvent.setup().selectOptions(screen.getByLabelText("Share status"), "expired")
      await screen.findByText("No shares match this status.")
      expect(oldSignal?.aborted).toBe(true)
      await act(async () =>
        pending.resolve(
          status === 200
            ? json({ items: [shares[0]] })
            : json({ message: "old unauthorized" }, 401),
        ),
      )
      expect(screen.getByRole("heading", { name: "Shares" })).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: "View share Historical share" }),
      ).not.toBeInTheDocument()
    },
  )

  it("aborts obsolete detail reads on selection and close; late content stays hidden", async () => {
    shares.push(makeShare("second", "Second"))
    await showPage()
    const pending = deferred<Response>()
    const signals: (AbortSignal | null | undefined)[] = []
    intercept = (path, init) => {
      if (path !== `account/shares/${firstID}`) return
      signals.push(init?.signal)
      return pending.promise
    }
    const user = userEvent.setup()
    await viewShare()
    await user.click(screen.getByRole("button", { name: "View share Second" }))
    const region = await screen.findByRole("region", { name: "Share details: Second" })
    await within(region).findByRole("heading", { name: "Private Markdown" })
    expect(signals[0]?.aborted).toBe(true)
    await act(async () => pending.resolve(json({ ...shares[0], content: "# Obsolete secret" })))
    expect(screen.queryByRole("heading", { name: "Obsolete secret" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close share details" }))
    expect(screen.queryByRole("heading", { name: "Private Markdown" })).not.toBeInTheDocument()
  })

  it.each(["list", "detail", "mutation"])(
    "clears private content and account data on a current %s 401",
    async (source) => {
      await showPage()
      const region = await viewShare()
      await within(region).findByRole("heading", { name: "Private Markdown" })
      intercept = (path, init) => {
        const matches =
          source === "list"
            ? path.startsWith("account/shares?")
            : path === `account/shares/${firstID}` &&
              init?.method === (source === "mutation" ? "DELETE" : "GET")
        return matches ? Promise.resolve(json({ message: "Session expired." }, 401)) : undefined
      }
      const user = userEvent.setup()
      if (source === "mutation") {
        await user.click(screen.getByRole("button", { name: "Revoke share Historical share" }))
        await user.click(screen.getByRole("button", { name: "Confirm revocation" }))
      } else await user.click(screen.getByRole("button", { name: "Refresh shares" }))
      await screen.findByRole("button", { name: "Sign in with passkey" })
      expect(screen.getByText("Your session expired. Sign in again.")).toBeInTheDocument()
      expect(screen.queryByRole("region", { name: "Shares" })).not.toBeInTheDocument()
      expect(screen.queryByRole("heading", { name: "Private Markdown" })).not.toBeInTheDocument()
      expect(screen.queryByText(firstID)).not.toBeInTheDocument()
    },
  )

  it.each(["logout", "unmount"])(
    "aborts pending private reads on %s and cannot restore late content",
    async (action) => {
      const page = await showPage()
      const pending = deferred<Response>()
      let signal: AbortSignal | null | undefined
      intercept = (path, init) => {
        if (path !== `account/shares/${firstID}`) return
        signal = init?.signal
        return pending.promise
      }
      await viewShare()
      if (action === "logout") {
        await userEvent.setup().click(screen.getByRole("button", { name: "Log out" }))
        await screen.findByRole("button", { name: "Sign in with passkey" })
      } else page.unmount()
      expect(signal?.aborted).toBe(true)
      await act(async () => pending.resolve(json({ ...shares[0], content: "# Late secret" })))
      expect(screen.queryByRole("heading", { name: "Late secret" })).not.toBeInTheDocument()
    },
  )

  it.each(["refresh", "close"])(
    "aborts a pending detail on %s and ignores late content",
    async (action) => {
      await showPage()
      const pending = deferred<Response>()
      let signal: AbortSignal | null | undefined
      intercept = (path, init) => {
        if (path !== `account/shares/${firstID}`) return
        signal = init?.signal
        return pending.promise
      }
      await viewShare()
      intercept = undefined
      await userEvent.setup().click(
        screen.getByRole("button", {
          name: action === "refresh" ? "Refresh shares" : "Close share details",
        }),
      )
      expect(signal?.aborted).toBe(true)
      if (action === "refresh") await screen.findByRole("heading", { name: "Private Markdown" })
      await act(async () => pending.resolve(json({ ...shares[0], content: "# Obsolete secret" })))
      expect(screen.queryByRole("heading", { name: "Obsolete secret" })).not.toBeInTheDocument()
    },
  )

  it("allows reads but disables revocation when passkeys are not supported", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false)
    await showPage()
    expect(
      await screen.findByRole("button", { name: "Revoke share Historical share" }),
    ).toBeDisabled()
    const region = await viewShare()
    await within(region).findByRole("heading", { name: "Private Markdown" })
    expect(startAuthentication).not.toHaveBeenCalled()
  })

  it("keeps duplicate submissions disabled until DELETE finishes and ignores completion after unmount", async () => {
    const page = await showPage()
    const pending = deferred<Response>()
    let signal: AbortSignal | null | undefined
    intercept = (path, init) => {
      if (path !== `account/shares/${firstID}` || init?.method !== "DELETE") return
      signal = init.signal
      return pending.promise
    }
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Revoke share Historical share" }))
    const confirm = screen.getByRole("button", { name: "Confirm revocation" })
    await user.click(confirm)
    await waitFor(() => expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(1))
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(1)
    page.unmount()
    expect(signal?.aborted).toBe(true)
    const count = fetchMock.mock.calls.length
    await act(async () => pending.resolve(new Response(null, { status: 204 })))
    expect(fetchMock.mock.calls).toHaveLength(count)
  })

  it("cancels a pending parent verification when a parallel list reports session expiry", async () => {
    const pending = deferred<never>()
    vi.mocked(startAuthentication).mockReturnValueOnce(pending.promise)
    const pendingList = deferred<Response>()
    await showPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Revoke share Historical share" }))
    intercept = (path) => (path.startsWith("account/shares?") ? pendingList.promise : undefined)
    await user.click(screen.getByRole("button", { name: "Refresh shares" }))
    await user.click(screen.getByRole("button", { name: "Confirm revocation" }))
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce())
    await act(async () => pendingList.resolve(json({}, 401)))
    await screen.findByRole("button", { name: "Sign in with passkey" })
    expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(credential as never))
    expect(requests("auth/verify/finish", "POST")).toHaveLength(0)
    expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(0)
  })
})
