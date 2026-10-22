import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../App"
import { clearRequestCacheForTests } from "../api"
import { ThemeProvider } from "../theme"
import { HomePage } from "./HomePage"

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }) },
}))

const token = "A".repeat(43)
const gist = "7dbaf8170c7292354678069a9acb061f"

beforeEach(() => {
  clearRequestCacheForTests()
  window.history.replaceState({}, "", "/")
})

function renderHome() {
  return render(
    <ThemeProvider>
      <HomePage />
    </ThemeProvider>,
  )
}

describe("HomePage", () => {
  it("shows a labeled form and a bundled example without requests", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { container } = renderHome()
    const input = screen.getByRole("textbox", { name: "Document URL" })
    expect(input).toHaveAttribute("autocomplete", "off")
    expect(input).not.toHaveAttribute("name")
    expect(input).not.toHaveAttribute("aria-invalid", "true")
    expect(input).toHaveAccessibleDescription(expect.stringContaining("Use a share URL"))
    expect(screen.getByRole("button", { name: "Open document" })).toHaveAttribute("type", "submit")
    expect(screen.getByRole("link", { name: "View example" })).toHaveAttribute("href", "/example")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(["", "/s/short", `https://evil.test/s/${token}`, `/s/${token}?debug=1`])(
    "rejects %s locally with an associated correction hint",
    async (value) => {
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)
      renderHome()
      const push = vi.spyOn(window.history, "pushState")
      const persist = vi.spyOn(Storage.prototype, "setItem")
      const user = userEvent.setup()
      const input = screen.getByRole("textbox", { name: "Document URL" })
      fireEvent.change(input, { target: { value } })
      expect(fetchMock).not.toHaveBeenCalled()
      await user.click(screen.getByRole("button", { name: "Open document" }))
      expect(input).toHaveValue(value)
      expect(input).toHaveFocus()
      expect(input).toHaveAttribute("aria-invalid", "true")
      expect(input).toHaveAccessibleDescription(
        expect.stringContaining("Check the complete share token"),
      )
      expect(screen.getByRole("alert")).toHaveTextContent("Enter a supported document URL")
      expect(fetchMock).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
      expect(persist).not.toHaveBeenCalled()
      fireEvent.change(input, { target: { value: `/#/s/${token}` } })
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(input).toHaveAttribute("aria-invalid", "false")
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it.each([
    [`/s/${token}`, `/s/${token}`, ""],
    [`/#/s/${token}`, "/", `#/s/${token}`],
    [`${window.location.origin}/#/s/${token}`, "/", `#/s/${token}`],
  ])("submits %s with exactly one consuming read in StrictMode", async (value, pathname, hash) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: "# Opened document",
          created_at: "2026-01-01T00:00:00Z",
          view_count: 1,
        }),
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    render(
      <StrictMode>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </StrictMode>,
    )
    const persist = vi.spyOn(Storage.prototype, "setItem")
    const push = vi.spyOn(window.history, "pushState")
    const input = screen.getByRole("textbox", { name: "Document URL" })
    fireEvent.change(input, { target: { value } })
    expect(fetchMock).not.toHaveBeenCalled()
    await user.click(input)
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("heading", { name: "Opened document" })).toBeInTheDocument()
    expect(window.location.pathname).toBe(pathname)
    expect(window.location.hash).toBe(hash)
    expect(window.location.search).toBe("")
    expect(push).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(`/v1/shares/${token}`, expect.any(Object))
    expect(persist).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Show raw Markdown" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it("normalizes a GitHub URL and loads only the existing local Gist reader", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          files: {
            "README.md": { filename: "README.md", language: "Markdown", content: "# Opened Gist" },
          },
        }),
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    render(
      <StrictMode>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </StrictMode>,
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Document URL" }), {
      target: { value: `https://gist.github.com/owner/${gist}` },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Open document" }))
    expect(await screen.findByRole("heading", { name: "Opened Gist" })).toBeInTheDocument()
    expect(window.location.pathname).toBe("/gist/")
    expect(window.location.hash).toBe(`#${gist}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/gists/${gist}`,
      expect.any(Object),
    )
  })

  it("allows correction and then loads a valid share once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: "# Corrected URL",
          created_at: "2026-01-01T00:00:00Z",
          view_count: 1,
        }),
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    )
    const input = screen.getByRole("textbox", { name: "Document URL" })
    fireEvent.change(input, { target: { value: "/s/short" } })
    await user.click(screen.getByRole("button", { name: "Open document" }))
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: `/#/s/${token}` } })
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("heading", { name: "Corrected URL" })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("opens the bundled example and clears input when returning home", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Document URL" }), {
      target: { value: `/#/s/${token}` },
    })
    await user.click(screen.getByRole("link", { name: "View example" }))
    expect(await screen.findByRole("heading", { name: "Example document" })).toBeInTheDocument()
    expect(window.location.pathname).toBe("/example")
    window.history.back()
    expect(await screen.findByRole("textbox", { name: "Document URL" })).toHaveValue("")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("ignores repeated valid submissions before the page changes", () => {
    vi.stubGlobal("fetch", vi.fn())
    renderHome()
    const push = vi.spyOn(window.history, "pushState")
    const input = screen.getByRole("textbox", { name: "Document URL" })
    fireEvent.change(input, { target: { value: `/#/s/${token}` } })
    const form = input.closest("form")
    if (!form) throw new Error("Document entry form missing")
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(push).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})
