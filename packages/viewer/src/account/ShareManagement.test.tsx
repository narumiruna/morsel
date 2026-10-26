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
import { App } from "../App"
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
let publicLinks: Map<string, string>
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let intercept: ((path: string, init?: RequestInit) => Promise<Response> | undefined) | undefined

function json(body: unknown, status = 200) {
  const id = account?.account_id ?? "10000000-0000-4000-8000-000000000001"
  const value =
    body && typeof body === "object" && "authenticated" in body && body.authenticated
      ? { account_id: id, display_name: "Owner", ...body }
      : body
  return new Response(JSON.stringify(value), { status, headers: { "X-Morsel-Account-ID": id } })
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
    link_available: true,
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
  window.history.replaceState({}, "", "/manage/shares")
  const page = (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  )
  const result = render(strict ? <StrictMode>{page}</StrictMode> : page)
  await screen.findByRole("heading", { name: "Shares" })
  return result
}

async function revokeItem(label = "Historical share") {
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: `More actions for ${label}` }))
  return screen.findByRole("menuitem", { name: `Revoke share ${label}` })
}

async function viewShare(label = "Historical share") {
  await userEvent.setup().click(await screen.findByRole("link", { name: `Preview share ${label}` }))
  return screen.findByRole("dialog", { name: `Share details: ${label}` })
}

beforeEach(() => {
  shares = [makeShare()]
  publicLinks = new Map()
  vi.stubGlobal("ClipboardItem", undefined)
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
    if (path === "auth/logout")
      return new Response(null, {
        status: 204,
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
      })
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
    if (path.startsWith("account/shares/") && path.endsWith("/link")) {
      const id = path.slice("account/shares/".length, -"/link".length)
      const canonical = publicLinks.get(id)
      if (!canonical)
        return json({ code: "link_unavailable", message: "The original link was not saved." }, 404)
      return json({ share_url: canonical })
    }
    if (path.startsWith("account/shares/")) {
      const share = shares.find(
        (item) => item.id === decodeURIComponent(path.slice("account/shares/".length)),
      )
      if (!share) return json({ message: "Share not found." }, 404)
      if (init?.method === "DELETE") {
        share.revoked_at = created
        share.status = "revoked"
        return new Response(null, {
          status: 204,
          headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        })
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
    expect(within(list).getAllByRole("columnheader")).toHaveLength(5)
    for (const name of ["Title", "Status", "Views", "Created", "Actions"])
      expect(within(list).getByRole("columnheader", { name })).toBeInTheDocument()
    for (const label of shares.map((share) => share.label))
      expect(within(list).getByRole("link", { name: `Preview share ${label}` })).toBeEnabled()
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
      await screen.findByRole("link", { name: "Preview share Unavailable" })
      expect(screen.queryByRole("link", { name: "Preview share Other" })).not.toBeInTheDocument()
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
      expect(within(region).getByText(/share ID is not a public link/)).toBeInTheDocument()
      expect(
        within(region).queryByRole("button", { name: /copy.*(url|link)/i }),
      ).not.toBeInTheDocument()
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
    await screen.findByRole("link", { name: "Preview share Historical share" })
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
    await screen.findByRole("link", { name: "Preview share Historical share" })
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

  it("toggles Views and Created with the keyboard and keeps header focus while loading", async () => {
    await showPage()
    const table = await screen.findByRole("table", { name: "Share history" })
    await screen.findByRole("link", { name: "Preview share Historical share" })
    const views = within(table).getByRole("button", { name: "Views" })
    const createdHeader = within(table).getByRole("columnheader", { name: "Created" })
    expect(createdHeader).toHaveAttribute("aria-sort", "descending")
    const pending = deferred<Response>()
    intercept = (path) => (path.startsWith("account/shares?") ? pending.promise : undefined)
    const user = userEvent.setup()
    views.focus()
    await user.keyboard("{Enter}")
    expect(screen.getByText("Loading shares…")).toBeInTheDocument()
    expect(views).toHaveFocus()
    expect(table).toHaveAttribute("aria-busy", "true")
    expect(within(table).getByRole("columnheader", { name: "Views" })).toHaveAttribute(
      "aria-sort",
      "descending",
    )
    expect(createdHeader).toHaveAttribute("aria-sort", "none")
    expect(screen.getByRole("combobox", { name: "Share order" })).toHaveValue("most_views")
    await act(async () => pending.resolve(json({ items: shares, matching_count: 1 })))
    await screen.findByRole("link", { name: "Preview share Historical share" })
    expect(views).toHaveFocus()
    intercept = undefined
    for (const [button, expected, direction] of [
      [views, "least_views", "ascending"],
      [within(table).getByRole("button", { name: "Created" }), "newest", "descending"],
      [within(table).getByRole("button", { name: "Created" }), "oldest", "ascending"],
    ] as const) {
      button.focus()
      await user.keyboard(" ")
      await screen.findByRole("link", { name: "Preview share Historical share" })
      const params = new URL(String(managementRequests().at(-1)?.[0]), "https://example.test")
        .searchParams
      expect(params.get("sort")).toBe(expected)
      expect(button.closest("th")).toHaveAttribute("aria-sort", direction)
      expect(button).toHaveFocus()
      expect(screen.getByRole("combobox", { name: "Share order" })).toHaveValue(expected)
    }
  })

  it.each([200, 401])(
    "aborts a replaced view order and ignores its late %s response",
    async (status) => {
      await showPage()
      await screen.findByRole("link", { name: "Preview share Historical share" })
      const pending = deferred<Response>()
      let signal: AbortSignal | null | undefined
      intercept = (path, init) => {
        if (
          !path.startsWith("account/shares?") ||
          new URLSearchParams(path.split("?")[1]).get("sort") !== "most_views"
        )
          return
        signal = init?.signal
        return pending.promise
      }
      const user = userEvent.setup()
      await user.click(screen.getByRole("button", { name: "Views" }))
      await screen.findByText("Loading shares…")
      await user.click(screen.getByRole("button", { name: "Views" }))
      await screen.findByRole("link", { name: "Preview share Historical share" })
      expect(signal?.aborted).toBe(true)
      await act(async () =>
        pending.resolve(
          status === 401
            ? json({}, 401)
            : json({ items: [makeShare("late", "Obsolete")], matching_count: 999 }),
        ),
      )
      expect(screen.getByRole("combobox", { name: "Share order" })).toHaveValue("least_views")
      expect(screen.getByText("1 matching shares · Page 1")).toBeInTheDocument()
      expect(screen.queryByText("Obsolete")).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Sign in with passkey" })).not.toBeInTheDocument()
    },
  )

  it.each(["most_views", "least_views"])(
    "resets pagination for %s without losing the server search or status",
    async (order) => {
      intercept = (path) => {
        if (!path.startsWith("account/shares?")) return
        const params = new URLSearchParams(path.split("?")[1])
        return Promise.resolve(
          json({
            items: shares,
            matching_count: 30,
            ...(params.has("cursor") ? {} : { next_cursor: "next" }),
          }),
        )
      }
      await showPage()
      const user = userEvent.setup()
      await user.selectOptions(screen.getByRole("combobox", { name: "Share status" }), "active")
      await user.type(screen.getByRole("searchbox", { name: "Search shares" }), "Historical{Enter}")
      await screen.findByText("30 matching shares · Page 1")
      await user.click(screen.getByRole("button", { name: "Next shares" }))
      await screen.findByText("30 matching shares · Page 2")
      await user.selectOptions(screen.getByRole("combobox", { name: "Share order" }), order)
      await screen.findByText("30 matching shares · Page 1")
      let params = new URL(String(managementRequests().at(-1)?.[0]), "https://example.test")
        .searchParams
      expect(params.get("sort")).toBe(order)
      expect(params.get("q")).toBe("Historical")
      expect(params.get("status")).toBe("active")
      expect(params.has("cursor")).toBe(false)
      expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
      await user.click(screen.getByRole("button", { name: "Next shares" }))
      await screen.findByText("30 matching shares · Page 2")
      params = new URL(String(managementRequests().at(-1)?.[0]), "https://example.test")
        .searchParams
      expect(params.get("sort")).toBe(order)
      expect(params.get("cursor")).toBe("next")
      expect(params.get("q")).toBe("Historical")
      expect(params.get("status")).toBe("active")
    },
  )

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
    const preview = await screen.findByRole("link", { name: "Preview share Historical share" })
    preview.focus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("heading", { name: "Share details: Historical share" })).toHaveFocus()
    const dialog = screen.getByRole("dialog", { name: "Share details: Historical share" })
    expect(dialog).toHaveAccessibleDescription("Preview does not use a view.")
    await within(dialog).findByText(firstID)
    expect(within(dialog).getByText("Never")).toBeInTheDocument()
    expect(within(dialog).getByText("Unlimited")).toBeInTheDocument()
    expect(within(dialog).getByText(/21 Oct 2026/)).toHaveTextContent("UTC")
    expect(within(dialog).getByText("Active", { selector: "dd" })).toBeInTheDocument()
    expect(within(dialog).getByText("3", { selector: "dd" })).toBeInTheDocument()
    const body = dialog.querySelector(".share-preview-body")
    const markdown = within(dialog).getByRole("heading", { name: "Private Markdown" })
    const metadata = dialog.querySelector<HTMLDListElement>(".share-facts")
    expect(body).toContainElement(markdown)
    expect(body).toContainElement(metadata)
    expect(
      markdown.compareDocumentPosition(metadata as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByRole("table", { name: "Share history" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Refresh shares" })).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Share status" })).not.toBeInTheDocument()
    const close = within(dialog).getByRole("button", { name: "Close share details" })
    close.focus()
    await user.tab({ shift: true })
    expect(within(dialog).getByRole("button", { name: "Copy share ID" })).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    expect(await axe.run(document.body).then((result) => result.violations)).toEqual([])
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(preview).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("heading", { name: "Share details: Historical share" })).toHaveFocus()
    await user.click(screen.getByRole("button", { name: "Close share details" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(preview).toHaveFocus()
    const more = screen.getByRole("button", { name: "More actions for Historical share" })
    await user.click(await revokeItem("Historical share"))
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Revoke share Historical share?" })).toHaveFocus(),
    )
    expect(screen.getByText(/requires passkey verification/)).toBeVisible()
    expect(screen.getByText(/Share ID:/)).toHaveTextContent(firstID)
    await user.click(screen.getByRole("button", { name: "Cancel revocation" }))
    await waitFor(() => expect(more).toHaveFocus())
    await user.click(await revokeItem("Historical share"))
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
    await user.click(await revokeItem("Historical share"))
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
    await screen.findByRole("link", { name: "Preview share Historical share" })
    expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Next shares" }))
    await screen.findByRole("link", { name: "Preview share Older share" })
    expect(screen.getByRole("button", { name: "Next shares" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Previous shares" }))
    await screen.findByRole("link", { name: "Preview share Historical share" })
    await user.click(screen.getByRole("button", { name: "Next shares" }))
    await screen.findByRole("link", { name: "Preview share Older share" })
    await user.selectOptions(screen.getByLabelText("Share status"), "expired")
    await screen.findByText("No shares match this search or status.")
    expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText("Share status"), "all")
    await screen.findByRole("link", { name: "Preview share Historical share" })
    expect(screen.getByRole("button", { name: "Previous shares" })).toBeDisabled()
  })

  it("requires explicit confirmation, permits cancellation, verifies with fresh state and refreshes list and detail", async () => {
    await showPage()
    const region = await viewShare()
    await within(region).findByRole("heading", { name: "Private Markdown" })
    const user = userEvent.setup()
    await user.click(within(region).getByRole("button", { name: "Close share details" }))
    await user.click(await revokeItem("Historical share"))
    expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(0)
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel revocation" }))
    expect(screen.queryByRole("button", { name: "Confirm revocation" })).not.toBeInTheDocument()
    await user.click(await revokeItem("Historical share"))
    account = { ...account, csrf_token: "fresh-csrf" }
    await user.click(screen.getByRole("button", { name: "Confirm revocation" }))
    await screen.findByText(/Share revoked\. Copies/)
    expect(
      within(await screen.findByRole("table", { name: "Share history" })).getByText("Revoked", {
        selector: "td",
      }),
    ).toBeInTheDocument()
    const reopened = await viewShare()
    await within(reopened).findByText("Revoked", { selector: "dd" })
    expect(requests(`account/shares/${firstID}`)).toHaveLength(2)
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
    await user.click(await revokeItem("Historical share"))
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
    await user.click(await revokeItem("Historical share"))
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
      await user.click(await revokeItem("Historical share"))
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
        screen.queryByRole("link", { name: "Preview share Historical share" }),
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
    await user.click(screen.getByRole("button", { name: "Close share details" }))
    await user.click(screen.getByRole("link", { name: "Preview share Second" }))
    const region = await screen.findByRole("dialog", { name: "Share details: Second" })
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
      const user = userEvent.setup()
      await user.click(within(region).getByRole("button", { name: "Close share details" }))
      const pendingDetail = deferred<Response>()
      intercept = (path, init) => {
        const matches =
          source === "list"
            ? path.startsWith("account/shares?")
            : path === `account/shares/${firstID}` &&
              init?.method === (source === "mutation" ? "DELETE" : "GET")
        if (!matches) return
        return source === "detail"
          ? pendingDetail.promise
          : Promise.resolve(json({ message: "Session expired." }, 401))
      }
      if (source === "mutation") {
        await user.click(await revokeItem("Historical share"))
        await user.click(screen.getByRole("button", { name: "Confirm revocation" }))
      } else if (source === "detail") {
        const reopened = await viewShare()
        expect(within(reopened).getByText("Loading share details…")).toBeInTheDocument()
        await act(async () => pendingDetail.resolve(json({ message: "Session expired." }, 401)))
      } else await user.click(screen.getByRole("button", { name: "Refresh shares" }))
      await screen.findByRole("button", { name: "Sign in with passkey" })
      expect(screen.getByText("Your session expired. Sign in again.")).toBeInTheDocument()
      expect(screen.queryByRole("region", { name: "Shares" })).not.toBeInTheDocument()
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
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
        await user.click(screen.getByRole("button", { name: "Close share details" }))
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
    "aborts a pending detail on close and ignores late content after %s",
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
      const user = userEvent.setup()
      await user.click(screen.getByRole("button", { name: "Close share details" }))
      expect(signal?.aborted).toBe(true)
      if (action === "refresh") {
        await user.click(screen.getByRole("button", { name: "Refresh shares" }))
        const reopened = await viewShare()
        await within(reopened).findByRole("heading", { name: "Private Markdown" })
      }
      await act(async () => pending.resolve(json({ ...shares[0], content: "# Obsolete secret" })))
      expect(screen.queryByRole("heading", { name: "Obsolete secret" })).not.toBeInTheDocument()
    },
  )

  it("allows reads but disables revocation when passkeys are not supported", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false)
    await showPage()
    expect(await revokeItem("Historical share")).toHaveAttribute("aria-disabled", "true")
    await userEvent.setup().keyboard("{Escape}")
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
    await user.click(await revokeItem("Historical share"))
    const confirm = screen.getByRole("button", { name: "Confirm revocation" })
    await user.click(confirm)
    await waitFor(() => expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(1))
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(requests(`account/shares/${firstID}`, "DELETE")).toHaveLength(1)
    page.unmount()
    expect(signal?.aborted).toBe(true)
    const count = fetchMock.mock.calls.length
    await act(async () =>
      pending.resolve(
        new Response(null, {
          status: 204,
          headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        }),
      ),
    )
    expect(fetchMock.mock.calls).toHaveLength(count)
  })

  it("cancels a pending parent verification when a parallel list reports session expiry", async () => {
    const pending = deferred<never>()
    vi.mocked(startAuthentication).mockReturnValueOnce(pending.promise)
    const pendingList = deferred<Response>()
    await showPage()
    const user = userEvent.setup()
    await user.click(await revokeItem("Historical share"))
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

describe("public share links", () => {
  const publicURL = () => `${window.location.origin}/#/s/${"A".repeat(43)}`

  async function showLink(user: ReturnType<typeof userEvent.setup>, label = "Historical share") {
    await user.click(await screen.findByRole("button", { name: `More actions for ${label}` }))
    await user.click(await screen.findByRole("menuitem", { name: "Show link" }))
    return screen.findByRole("region", { name: `Public link: ${label}` })
  }

  it("marks legacy URLs unavailable without input or misleading actions", async () => {
    shares = [{ ...makeShare(), link_available: false }]
    await showPage()
    const user = userEvent.setup()
    const row = await screen.findByRole("row", { name: /Preview share Historical share/ })
    expect(within(row).getByText("Link unavailable")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Copy link for Historical share" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "More actions for Historical share" }))
    expect(await screen.findByRole("menuitem", { name: "Show link" })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByRole("textbox", { name: "Original public URL" })).toBeNull()
    expect(requests(`account/shares/${firstID}/link`)).toHaveLength(0)
    await user.keyboard("{Escape}")
    expect(await axe.run(document.body).then((result) => result.violations)).toEqual([])
  })

  it("copies each canonical URL on the first click and reports success only after completion", async () => {
    shares = [makeShare(), makeShare("second", "Preview-enabled share")]
    const previewURL = `${window.location.origin}/s/${"B".repeat(42)}A`
    publicLinks.set(firstID, publicURL())
    publicLinks.set("second", previewURL)
    await showPage()
    const user = userEvent.setup()
    const pending = deferred<void>()
    const write = vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(pending.promise)
    await user.click(await screen.findByRole("button", { name: "Copy link for Historical share" }))
    await waitFor(() => expect(write).toHaveBeenCalledWith(publicURL()))
    expect(screen.queryByText(/Link copied/)).toBeNull()
    expect(screen.queryByRole("region", { name: /Public link:/ })).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
    await act(async () => pending.resolve())
    expect(screen.getByText("Link copied. Historical share")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Copy link for Preview-enabled share" }))
    await waitFor(() => expect(write).toHaveBeenLastCalledWith(previewURL))
    await user.click(screen.getByRole("button", { name: "Copy link for Historical share" }))
    expect(write).toHaveBeenLastCalledWith(publicURL())
    expect(requests(`account/shares/${firstID}/link`)).toHaveLength(1)
    expect(requests(`account/shares/${firstID}/link`, "POST")).toHaveLength(0)
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(shares.map((share) => share.view_count)).toEqual([3, 3])
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/v1/shares"))).toBe(false)
  })

  it("starts a promised clipboard write before retrieval completes to preserve user activation", async () => {
    const response = deferred<Response>()
    const clipboard = deferred<void>()
    intercept = (path) => (path.endsWith("/link") ? response.promise : undefined)
    await showPage()
    const user = userEvent.setup()
    class PromisedItem {
      constructor(public data: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal("ClipboardItem", PromisedItem)
    const write = vi.spyOn(navigator.clipboard, "write").mockReturnValue(clipboard.promise)
    await user.click(await screen.findByRole("button", { name: "Copy link for Historical share" }))
    expect(write).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Link copied/)).toBeNull()
    await act(async () => response.resolve(json({ share_url: publicURL() })))
    const item = write.mock.calls[0]?.[0][0] as unknown as PromisedItem
    expect(await item.data["text/plain"]).toHaveProperty("type", "text/plain")
    await act(async () => clipboard.resolve())
    expect(screen.getByText("Link copied. Historical share")).toBeVisible()
  })

  it.each(["denied", "unavailable"])(
    "shows selectable text inline when clipboard access is %s",
    async (failure) => {
      publicLinks.set(firstID, publicURL())
      await showPage()
      const user = userEvent.setup()
      const clipboard = navigator.clipboard
      if (failure === "denied")
        vi.spyOn(clipboard, "writeText").mockRejectedValue(new Error("denied"))
      else Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
      try {
        await user.click(
          await screen.findByRole("button", { name: "Copy link for Historical share" }),
        )
        const panel = await screen.findByRole("region", { name: "Public link: Historical share" })
        expect(screen.getByText(/Could not copy link/)).toBeVisible()
        expect(screen.queryByText(/Link copied/)).toBeNull()
        expect(screen.queryByRole("dialog")).toBeNull()
        const input = within(panel).getByRole("textbox", {
          name: "Public share URL",
        }) as HTMLTextAreaElement
        expect(input).toHaveValue(publicURL())
        await user.click(within(panel).getByRole("button", { name: "Select link" }))
        expect(input).toHaveFocus()
        expect(input.selectionStart).toBe(0)
        expect(input.selectionEnd).toBe(publicURL().length)
        expect(await axe.run(document.body).then((result) => result.violations)).toEqual([])
      } finally {
        Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true })
      }
    },
  )

  it.each(["revoked", "expired", "view_limit_exhausted"] as const)(
    "does not reactivate a %s share",
    async (status) => {
      shares = [makeShare(firstID, "Unavailable", status)]
      publicLinks.set(firstID, publicURL())
      await showPage()
      const user = userEvent.setup()
      const before = JSON.stringify(shares)
      const panel = await showLink(user, "Unavailable")
      expect(await within(panel).findByText(/Copying does not reactivate it/)).toBeVisible()
      await user.click(screen.getByRole("button", { name: "Copy link for Unavailable" }))
      expect(JSON.stringify(shares)).toBe(before)
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false)
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/v1/shares"))).toBe(false)
    },
  )

  it("shows the URL directly and restores keyboard focus on Escape", async () => {
    publicLinks.set(firstID, publicURL())
    await showPage()
    const user = userEvent.setup()
    const more = await screen.findByRole("button", { name: "More actions for Historical share" })
    more.focus()
    await user.keyboard("{ArrowDown}")
    const show = await screen.findByRole("menuitem", { name: "Show link" })
    await waitFor(() => expect(show).toHaveFocus())
    await user.keyboard("{Enter}")
    const input = await screen.findByRole("textbox", { name: "Public share URL" })
    expect(input).toHaveValue(publicURL())
    await waitFor(() => expect(input).toHaveFocus())
    expect(screen.queryByRole("dialog")).toBeNull()
    await user.keyboard("{Escape}")
    expect(more).toHaveFocus()
    expect(screen.queryByDisplayValue(publicURL())).toBeNull()
  })

  it("aborts retrieval on hide, ignores late results, and retrieves again after remount", async () => {
    publicLinks.set(firstID, publicURL())
    const page = await showPage()
    const user = userEvent.setup()
    const pending = deferred<Response>()
    let signal: AbortSignal | undefined
    intercept = (path, init) => {
      if (!path.endsWith("/link")) return
      signal = init?.signal as AbortSignal
      return pending.promise
    }
    const panel = await showLink(user)
    await user.click(within(panel).getByRole("button", { name: "Hide link" }))
    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve(json({ share_url: publicURL() })))
    expect(screen.queryByDisplayValue(publicURL())).toBeNull()
    intercept = undefined
    await showLink(user)
    await screen.findByDisplayValue(publicURL())
    page.unmount()
    await showPage()
    expect(screen.queryByDisplayValue(publicURL())).toBeNull()
    await user.click(await screen.findByRole("button", { name: "Copy link for Historical share" }))
    await waitFor(() => expect(requests(`account/shares/${firstID}/link`)).toHaveLength(3))
    await screen.findByText("Link copied. Historical share")
  })

  it("reports retrieval errors inline with retry and handles missing retained links", async () => {
    publicLinks.set(firstID, publicURL())
    intercept = (path) =>
      path.endsWith("/link") ? Promise.reject(new Error("offline")) : undefined
    await showPage()
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, "writeText")
    await user.click(await screen.findByRole("button", { name: "Copy link for Historical share" }))
    expect(await screen.findByText(/Check your connection/)).toBeVisible()
    expect(write).not.toHaveBeenCalled()
    intercept = undefined
    await user.click(screen.getByRole("button", { name: "Retry link" }))
    await screen.findByDisplayValue(publicURL())
    await user.click(screen.getByRole("button", { name: "Hide link" }))
    shares.push(makeShare("missing", "Missing link"))
    await user.click(screen.getByRole("button", { name: "Refresh shares" }))
    await user.click(await screen.findByRole("button", { name: "Copy link for Missing link" }))
    expect(await screen.findByText("The original link was not saved.")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Copy link for Missing link" })).toBeNull()
    expect(screen.queryByRole("textbox", { name: "Original public URL" })).toBeNull()
  })

  it("ignores a delayed link response after switching rows", async () => {
    shares = [makeShare(), makeShare("second", "Second share")]
    const secondURL = `${window.location.origin}/s/${"B".repeat(42)}A`
    publicLinks.set("second", secondURL)
    const pending = deferred<Response>()
    let signal: AbortSignal | undefined
    intercept = (path, init) => {
      if (path !== `account/shares/${firstID}/link`) return
      signal = init?.signal as AbortSignal
      return pending.promise
    }
    await showPage()
    const user = userEvent.setup()
    await showLink(user)
    await showLink(user, "Second share")
    await screen.findByDisplayValue(secondURL)
    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve(json({ share_url: publicURL() })))
    expect(screen.queryByDisplayValue(publicURL())).toBeNull()
    expect(screen.getByRole("textbox", { name: "Public share URL" })).toHaveValue(secondURL)
  })

  it("handles immediate clipboard rejection followed by a retrieval failure", async () => {
    const pending = deferred<Response>()
    intercept = (path) => (path.endsWith("/link") ? pending.promise : undefined)
    await showPage()
    const user = userEvent.setup()
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public data: Record<string, Promise<Blob>>) {}
      },
    )
    vi.spyOn(navigator.clipboard, "write").mockRejectedValue(new Error("denied"))
    await user.click(await screen.findByRole("button", { name: "Copy link for Historical share" }))
    await act(async () => pending.reject(new Error("offline")))
    expect(await screen.findByText(/Check your connection/)).toBeVisible()
    expect(screen.queryByText(/Link copied/)).toBeNull()
    expect(screen.queryByRole("textbox", { name: "Public share URL" })).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("clears private state on a retrieval 401 and ignores late clipboard results after unmount", async () => {
    publicLinks.set(firstID, publicURL())
    const page = await showPage()
    const user = userEvent.setup()
    const pending = deferred<void>()
    vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(pending.promise)
    await user.click(await screen.findByRole("button", { name: "Copy link for Historical share" }))
    page.unmount()
    await act(async () => pending.resolve())
    expect(screen.queryByText(/Link copied/)).toBeNull()
    await showPage()
    intercept = (path) => (path.endsWith("/link") ? Promise.resolve(json({}, 401)) : undefined)
    await user.click(await screen.findByRole("button", { name: "Copy link for Historical share" }))
    await screen.findByRole("button", { name: "Sign in with passkey" })
    expect(screen.queryByDisplayValue(publicURL())).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
