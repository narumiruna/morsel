import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { StrictMode } from "react"
import { describe, expect, it, vi } from "vitest"
import type { ManagedShare } from "../management"
import { ThemeProvider } from "../theme"
import { ManagePage } from "./ManagePage"

const share: ManagedShare = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Release notes",
  excerpt: "# Release notes\nA previous morsel.",
  created_at: "2026-01-01T00:00:00Z",
  view_count: 2,
  max_views: 5,
  status: "active",
}

function response(items: ManagedShare[] = [share], next_offset?: number) {
  return new Response(JSON.stringify({ items, next_offset }), { status: 200 })
}

function renderPage() {
  return render(
    <StrictMode>
      <ThemeProvider>
        <ManagePage />
      </ThemeProvider>
    </StrictMode>,
  )
}

async function connect(key = "test-admin-key") {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText("API key"), key)
  await user.click(screen.getByRole("button", { name: "Connect" }))
  return user
}

describe("ManagePage", () => {
  it("requires a key, shows metadata without consuming a view, and does not persist the key", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response()))
    vi.stubGlobal("fetch", fetchMock)
    const persist = vi.spyOn(Storage.prototype, "setItem")
    const { container } = renderPage()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password")
    await connect()
    expect(await screen.findByRole("heading", { name: "Release notes" })).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("Views: 2 / 5")).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/shares?limit=50&offset=0",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json", Authorization: "Bearer test-admin-key" },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    )
    expect(persist).not.toHaveBeenCalled()
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }))
    expect(screen.queryByRole("heading", { name: "Release notes" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("API key")).toHaveValue("")
  })

  it("paginates and refreshes the current page", async () => {
    const older = { ...share, id: "older", title: "Older morsel" }
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(url.endsWith("offset=50") ? response([older]) : response([share], 50)),
      )
    vi.stubGlobal("fetch", fetchMock)
    renderPage()
    const user = await connect()
    await screen.findByRole("heading", { name: "Release notes" })
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(await screen.findByRole("heading", { name: "Older morsel" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Release notes" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/v1/shares?limit=50&offset=50")
    await user.click(screen.getByRole("button", { name: "Previous" }))
    expect(await screen.findByRole("heading", { name: "Release notes" })).toBeInTheDocument()
  })

  it("requires confirmation before revocation and refreshes status after success", async () => {
    let revoked = false
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === "DELETE") {
        revoked = true
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(response([{ ...share, status: revoked ? "revoked" : "active" }]))
    })
    vi.stubGlobal("fetch", fetchMock)
    renderPage()
    const user = await connect()
    await screen.findByRole("heading", { name: "Release notes" })
    await user.click(screen.getByRole("button", { name: "Revoke Release notes" }))
    const dialog = screen.getByRole("alertdialog", { name: "Revoke this morsel?" })
    expect(within(dialog).getByText(/permanently disables/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Revoke Release notes" })).toHaveFocus()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole("button", { name: "Revoke Release notes" }))
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }))
    expect(await screen.findByText("Revoked")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Revoke Release notes" })).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent("Morsel revoked.")
    expect(screen.getByRole("button", { name: "Disconnect" })).toHaveFocus()
    expect(fetchMock).toHaveBeenCalledWith(
      `/v1/shares/${share.id}`,
      expect.objectContaining({ method: "DELETE" }),
    )
  })

  it("keeps failed revocation open for retry", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(
          init.method === "DELETE" ? new Response(null, { status: 500 }) : response(),
        ),
      )
    vi.stubGlobal("fetch", fetchMock)
    renderPage()
    const user = await connect()
    await screen.findByRole("heading", { name: "Release notes" })
    await user.click(screen.getByRole("button", { name: "Revoke Release notes" }))
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }))
    const dialog = screen.getByRole("alertdialog")
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Unable to revoke")
    expect(within(dialog).getByRole("button", { name: "Confirm revoke" })).toBeEnabled()
  })

  it.each(["GET", "DELETE"])("clears the session when %s returns unauthorized", async (method) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((_url: string, init: RequestInit) =>
          Promise.resolve(
            init.method === method ? new Response(null, { status: 401 }) : response(),
          ),
        ),
    )
    renderPage()
    const user = await connect()
    if (method === "DELETE") {
      await screen.findByRole("heading", { name: "Release notes" })
      await user.click(screen.getByRole("button", { name: "Revoke Release notes" }))
      await user.click(screen.getByRole("button", { name: "Confirm revoke" }))
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid API key")
    expect(screen.getByLabelText("API key")).toHaveValue("")
    expect(screen.queryByRole("heading", { name: "Release notes" })).not.toBeInTheDocument()
  })

  it("supports retry after a network error and an empty list", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(response([]))
    vi.stubGlobal("fetch", fetchMock)
    renderPage()
    const user = await connect()
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load")
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    expect(await screen.findByText("No morsels yet.")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("ignores a late list response after disconnect", async () => {
    let resolve: ((value: Response) => void) | undefined
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    renderPage()
    const user = await connect()
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal
    await user.click(screen.getByRole("button", { name: "Disconnect" }))
    expect(signal.aborted).toBe(true)
    await act(async () => {
      resolve?.(response())
    })
    expect(screen.queryByRole("heading", { name: "Release notes" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("API key")).toHaveValue("")
  })

  it("clears the key and list when the document leaves the browser page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(response())),
    )
    renderPage()
    await connect()
    await screen.findByRole("heading", { name: "Release notes" })
    fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }))
    expect(screen.queryByRole("heading", { name: "Release notes" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("API key")).toHaveValue("")
  })

  it("shows all unavailable states and renders excerpts as text only", async () => {
    const items: ManagedShare[] = ["expired", "revoked", "view_limit_exhausted"].map(
      (status, index) => ({
        ...share,
        id: String(index),
        title: "",
        excerpt: '<img src="https://example.invalid/secret" onerror="alert(1)">',
        status: status as ManagedShare["status"],
      }),
    )
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(response(items))),
    )
    const { container } = renderPage()
    await connect()
    await screen.findByText("Expired")
    expect(screen.getByText("Revoked")).toBeInTheDocument()
    expect(screen.getByText("View limit reached")).toBeInTheDocument()
    expect(container.querySelector("img")).toBeNull()
  })
})
