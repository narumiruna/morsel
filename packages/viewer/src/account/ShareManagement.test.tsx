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
      "# Private Markdown\n\n**Owner content**\n\n<script>alert('unsafe')</script>\n\n[bad](javascript:alert(1))\n\n![Blocked image](https://example.test/secret.png)\n\n```mermaid\ngraph TD; A-->B\n```",
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
      <AccountPage section="shares" />
    </ThemeProvider>
  )
  const result = render(strict ? <StrictMode>{page}</StrictMode> : page)
  await screen.findByRole("heading", { name: "Shares" })
  return result
}

async function viewShare(label = "Historical share") {
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: `Preview share ${label}` }))
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
      const params = new URLSearchParams(path.split("?")[1])
      const filter = params.get("status")
      const query = params.get("q")?.toLowerCase() ?? ""
      const items = shares
        .filter(
          (share) =>
            (filter === "all" || filter === share.status) &&
            share.label.toLowerCase().includes(query),
        )
        .map(({ content: _content, ...metadata }) => metadata)
      return json({ items, matching_count: items.length })
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
    const list = await screen.findByRole("table", { name: "Share history" })
    expect(within(list).getAllByRole("row")).toHaveLength(6)
    expect(
      within(list)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Title", "Status", "Views", "Created", "Actions"])
    for (const label of shares.map((share) => share.label))
      expect(within(list).getByRole("button", { name: `Preview share ${label}` })).toBeEnabled()
    expect(within(list).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument()
    expect(list.querySelector("img")).toBeNull()
    expect(within(list).getByText("Expired", { selector: "td" })).toBeInTheDocument()
    expect(within(list).getByText("View limit exhausted", { selector: "td" })).toBeInTheDocument()
    expect(within(list).queryByText(firstID)).not.toBeInTheDocument()
    expect(within(list).queryByText("Unlimited")).not.toBeInTheDocument()
    expect(within(list).queryByText("Never")).not.toBeInTheDocument()
    expect(list.textContent).not.toContain("10:00:00")
    expect(within(list).getByText("3 / 4", { selector: "td" })).toBeInTheDocument()
    expect(within(list).getByText(/^Expires /)).toHaveTextContent("UTC")
    expect(screen.getByText("5 matching shares · Page 1")).toBeInTheDocument()
    expect(screen.getByText(/Last refreshed:/)).toHaveTextContent("UTC")
    expect(screen.getByText(/including shares created before account setup/)).not.toBeVisible()
    await userEvent.setup().click(screen.getByText("About share management"))
    expect(screen.getByText(/including shares created before account setup/)).toBeVisible()
    expect(screen.getByText(/snapshots/)).toBeVisible()
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
      await screen.findByRole("button", { name: "Preview share Unavailable" })
      expect(screen.queryByRole("button", { name: "Preview share Other" })).not.toBeInTheDocument()
      const region = await viewShare("Unavailable")
      await within(region).findByRole("heading", { name: "Private Markdown" })
      expect(within(region).getByText("Owner content").tagName).toBe("STRONG")
      expect(region.querySelector("script")).toBeNull()
      expect(region.querySelector("img")).toBeNull()
      expect(region.querySelector("svg")).toBeNull()
      expect(within(region).getByText("Image not loaded: Blocked image")).toBeInTheDocument()
      expect(within(region).getByText("graph TD; A-->B")).toHaveClass("language-mermaid")
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

  it("submits literal server search only on request, with trimmed 100-character Unicode queries", async () => {
    await showPage()
    await screen.findByRole("table", { name: "Share history" })
    const user = userEvent.setup()
    const input = screen.getByRole("searchbox", { name: "Search shares" })
    const count = managementRequests().length
    await user.type(input, "  Historical  ")
    expect(managementRequests()).toHaveLength(count)
    await user.keyboard("{Enter}")
    await screen.findByRole("button", { name: "Preview share Historical share" })
    expect(input).toHaveValue("Historical")
    let params = new URL(String(managementRequests().at(-1)?.[0]), "https://example.test")
      .searchParams
    expect(params.get("q")).toBe("Historical")
    expect(params.get("sort")).toBe("newest")
    expect(params.get("limit")).toBe("25")
    expect(params.has("cursor")).toBe(false)
    fireEvent.change(input, { target: { value: `  %_\\${"😀".repeat(105)}  ` } })
    await user.click(screen.getByRole("button", { name: "Search shares" }))
    await screen.findByText("No shares match this search or status.")
    params = new URL(String(managementRequests().at(-1)?.[0]), "https://example.test").searchParams
    expect(params.get("q")).toBe(`%_\\${"😀".repeat(97)}`)
    expect(Array.from(params.get("q") ?? "")).toHaveLength(100)
    expect(screen.getByText("0 matching shares · Page 1")).toBeInTheDocument()
  })

  it.each([200, 401])("aborts replaced searches and ignores a late %s response", async (status) => {
    await showPage()
    await screen.findByRole("table", { name: "Share history" })
    const pending = deferred<Response>()
    let signal: AbortSignal | null | undefined
    intercept = (path, init) => {
      if (
        !path.startsWith("account/shares?") ||
        new URLSearchParams(path.split("?")[1]).get("q") !== "old"
      )
        return
      signal = init?.signal
      return pending.promise
    }
    const user = userEvent.setup()
    const input = screen.getByRole("searchbox", { name: "Search shares" })
    await user.type(input, "old{Enter}")
    await screen.findByText("Loading shares…")
    await user.clear(input)
    await user.type(input, "Historical{Enter}")
    await screen.findByRole("button", { name: "Preview share Historical share" })
    expect(signal?.aborted).toBe(true)
    await act(async () =>
      pending.resolve(
        status === 401
          ? json({}, 401)
          : json({ items: [makeShare("late", "Obsolete")], matching_count: 999 }),
      ),
    )
    expect(screen.queryByText("Obsolete")).not.toBeInTheDocument()
    expect(screen.getByText("1 matching shares · Page 1")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sign in with passkey" })).not.toBeInTheDocument()
  })

  it("resets sequential pagination for search and sort and uses server counts before the cursor", async () => {
    intercept = (path) => {
      if (!path.startsWith("account/shares?")) return
      const params = new URLSearchParams(path.split("?")[1])
      return Promise.resolve(
        json({
          items: [shares[0]],
          matching_count: 73,
          ...(params.has("cursor") ? {} : { next_cursor: "next-page" }),
        }),
      )
    }
    await showPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Next shares" }))
    await screen.findByText("73 matching shares · Page 2")
    await user.selectOptions(screen.getByRole("combobox", { name: "Share order" }), "oldest")
    await screen.findByText("73 matching shares · Page 1")
    let params = new URL(String(managementRequests().at(-1)?.[0]), "https://example.test")
      .searchParams
    expect(params.get("sort")).toBe("oldest")
    expect(params.has("cursor")).toBe(false)
    await user.click(screen.getByRole("button", { name: "Next shares" }))
    await screen.findByText("73 matching shares · Page 2")
    await user.type(screen.getByRole("searchbox", { name: "Search shares" }), "Historical{Enter}")
    await screen.findByText("73 matching shares · Page 1")
    params = new URL(String(managementRequests().at(-1)?.[0]), "https://example.test").searchParams
    expect(params.get("q")).toBe("Historical")
    expect(params.get("sort")).toBe("oldest")
    expect(params.has("cursor")).toBe(false)
  })

  it("keeps pagination controls and keyboard focus stable while loading the next page", async () => {
    const pending = deferred<Response>()
    intercept = (path) => {
      if (!path.startsWith("account/shares?")) return
      return new URLSearchParams(path.split("?")[1]).has("cursor")
        ? pending.promise
        : Promise.resolve(json({ items: [shares[0]], matching_count: 60, next_cursor: "next" }))
    }
    await showPage()
    await screen.findByRole("table", { name: "Share history" })
    const user = userEvent.setup()
    const next = screen.getByRole("button", { name: "Next shares" })
    next.focus()
    await user.keyboard("{Enter}")
    expect(next).toBeDisabled()
    expect(next).toHaveFocus()
    await act(async () =>
      pending.resolve(json({ items: [shares[0]], matching_count: 60, next_cursor: "third" })),
    )
    await screen.findByText("60 matching shares · Page 2")
    expect(next).toBeEnabled()
    expect(next).toHaveFocus()
  })

  it("offers a keyboard-operated first-page reset for invalid cursors without retrying automatically", async () => {
    intercept = (path) => {
      if (!path.startsWith("account/shares?")) return
      const params = new URLSearchParams(path.split("?")[1])
      return Promise.resolve(
        params.has("cursor")
          ? json({ message: "Invalid cursor." }, 400)
          : json({ items: [shares[0]], matching_count: 30, next_cursor: "invalid" }),
      )
    }
    await showPage()
    const user = userEvent.setup()
    const next = await screen.findByRole("button", { name: "Next shares" })
    next.focus()
    await user.keyboard("{Enter}")
    const reset = await screen.findByRole("button", { name: "Reset share pages" })
    expect(managementRequests()).toHaveLength(2)
    expect(screen.queryByRole("button", { name: "Retry shares" })).not.toBeInTheDocument()
    reset.focus()
    await user.keyboard("{Enter}")
    await screen.findByText("30 matching shares · Page 1")
    expect(managementRequests()).toHaveLength(3)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false)
  })

  it("keeps the last successful refresh time on failure and announces completion without moving focus", async () => {
    await showPage()
    await screen.findByRole("table", { name: "Share history" })
    const user = userEvent.setup()
    const refresh = screen.getByRole("button", { name: "Refresh shares" })
    await user.click(refresh)
    await screen.findByRole("table", { name: "Share history" })
    expect(refresh).toHaveFocus()
    const refreshed = screen.getByText(/Last refreshed:/).textContent
    expect(screen.getByText("Shares refreshed. 1 matching shares. Page 1.")).toHaveAttribute(
      "role",
      "status",
    )
    intercept = (path) =>
      path.startsWith("account/shares?")
        ? Promise.resolve(json({ message: "Unavailable." }, 500))
        : undefined
    await user.click(refresh)
    await screen.findByText("Unavailable.")
    expect(screen.getByText(/Last refreshed:/)).toHaveTextContent(refreshed ?? "")
    intercept = undefined
    const retry = screen.getByRole("button", { name: "Retry shares" })
    retry.focus()
    await user.keyboard("{Enter}")
    await screen.findByRole("table", { name: "Share history" })
  })

  it("focuses preview and confirmation, restores their triggers, and uses a stable target after revocation", async () => {
    await showPage()
    const user = userEvent.setup()
    const preview = await screen.findByRole("button", { name: "Preview share Historical share" })
    preview.focus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("heading", { name: "Share details: Historical share" })).toHaveFocus()
    const region = screen.getByRole("region", { name: "Share details: Historical share" })
    await within(region).findByText(firstID)
    expect(within(region).getByText("Never")).toBeInTheDocument()
    expect(within(region).getByText("Unlimited")).toBeInTheDocument()
    expect(within(region).getByText(/21 Oct 2026/)).toHaveTextContent("UTC")
    await user.click(screen.getByRole("button", { name: "Close share details" }))
    expect(preview).toHaveFocus()
    const revoke = screen.getByRole("button", { name: "Revoke share Historical share" })
    await user.click(revoke)
    expect(screen.getByRole("heading", { name: "Revoke share Historical share?" })).toHaveFocus()
    expect(screen.getByText(/requires passkey verification/)).toBeVisible()
    expect(screen.getByText(/Share ID:/)).toHaveTextContent(firstID)
    await user.click(screen.getByRole("button", { name: "Cancel revocation" }))
    expect(revoke).toHaveFocus()
    await user.click(revoke)
    await user.click(screen.getByRole("button", { name: "Confirm revocation" }))
    await screen.findByText(/Share revoked\. Copies/)
    expect(screen.getByRole("heading", { name: "Shares" })).toHaveFocus()
    expect(
      screen.queryByRole("button", { name: "Revoke share Historical share" }),
    ).not.toBeInTheDocument()
  })

  it("copies only the share ID with explicit success and failure feedback", async () => {
    await showPage()
    const region = await viewShare()
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce(undefined)
    await user.click(await within(region).findByRole("button", { name: "Copy share ID" }))
    await within(region).findByText("Share ID copied.")
    expect(write).toHaveBeenCalledWith(firstID)
    write.mockRejectedValueOnce(new Error("Permission denied"))
    await user.click(within(region).getByRole("button", { name: "Copy share ID" }))
    await within(region).findByText("Could not copy share ID. Select and copy the ID below.")
    expect(within(region).queryByText("Share ID copied.")).not.toBeInTheDocument()
  })

  it("ignores late clipboard results after the preview is closed", async () => {
    await showPage()
    const region = await viewShare()
    const user = userEvent.setup()
    const pending = deferred<void>()
    vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(pending.promise)
    await user.click(await within(region).findByRole("button", { name: "Copy share ID" }))
    await user.click(within(region).getByRole("button", { name: "Close share details" }))
    await act(async () => pending.resolve())
    expect(screen.queryByText("Share ID copied.")).not.toBeInTheDocument()
    expect(screen.queryByText(firstID)).not.toBeInTheDocument()
  })

  it("resets page history after a confirmed revocation", async () => {
    intercept = (path) => {
      if (!path.startsWith("account/shares?")) return
      const params = new URLSearchParams(path.split("?")[1])
      return Promise.resolve(
        json({
          items: shares,
          matching_count: 26,
          ...(params.has("cursor") ? {} : { next_cursor: "page-two" }),
        }),
      )
    }
    await showPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Next shares" }))
    await screen.findByText("26 matching shares · Page 2")
    await user.click(screen.getByRole("button", { name: "Revoke share Historical share" }))
    await user.click(screen.getByRole("button", { name: "Confirm revocation" }))
    await screen.findByText("26 matching shares · Page 1")
    const params = new URL(String(managementRequests().at(-1)?.[0]), "https://example.test")
      .searchParams
    expect(params.has("cursor")).toBe(false)
    expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(1)
  })

  it("paginates with opaque cursors, supports previous, and resets cursor history on a filter change", async () => {
    intercept = (path) => {
      if (!path.startsWith("account/shares?")) return
      const params = new URLSearchParams(path.split("?")[1])
      expect(params.get("limit")).toBe("25")
      const next = params.get("cursor")
      if (params.get("status") !== "all") {
        expect(next).toBeNull()
        return Promise.resolve(json({ items: [], matching_count: 0 }))
      }
      return Promise.resolve(
        next
          ? json({ items: [makeShare("older", "Older share")], matching_count: 2 })
          : json({ items: [shares[0]], next_cursor: "opaque/+=", matching_count: 2 }),
      )
    }
    await showPage()
    const user = userEvent.setup()
    await screen.findByRole("button", { name: "Preview share Historical share" })
    expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Next shares" }))
    await screen.findByRole("button", { name: "Preview share Older share" })
    expect(screen.getByRole("button", { name: "Next shares" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Previous shares" }))
    await screen.findByRole("button", { name: "Preview share Historical share" })
    await user.click(screen.getByRole("button", { name: "Next shares" }))
    await screen.findByRole("button", { name: "Preview share Older share" })
    await user.selectOptions(screen.getByLabelText("Share status"), "expired")
    await screen.findByText("No shares match this search or status.")
    expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText("Share status"), "all")
    await screen.findByRole("button", { name: "Preview share Historical share" })
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
      within(await screen.findByRole("table", { name: "Share history" })).getByText("Revoked", {
        selector: "td",
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
    await screen.findByText("No shares match this search or status.")
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
      await screen.findByText("No shares match this search or status.")
      expect(oldSignal?.aborted).toBe(true)
      await act(async () =>
        pending.resolve(
          status === 200
            ? json({ items: [shares[0]], matching_count: 1 })
            : json({ message: "old unauthorized" }, 401),
        ),
      )
      expect(screen.getByRole("heading", { name: "Shares" })).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: "Preview share Historical share" }),
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
    await user.click(screen.getByRole("button", { name: "Preview share Second" }))
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
        const user = userEvent.setup()
        await user.click(screen.getByRole("button", { name: "Account" }))
        await user.click(screen.getByRole("menuitem", { name: "Log out" }))
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
