import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { clearRequestCacheForTests } from "./api"
import { ThemeProvider } from "./theme"

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }),
  },
}))

const token = "A".repeat(43)
const nextToken = "B".repeat(43)
const gist = "7dbaf8170c7292354678069a9acb061f"

function renderApp(strict = false) {
  const app = (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  )
  return render(strict ? <StrictMode>{app}</StrictMode> : app)
}

beforeEach(() => {
  clearRequestCacheForTests()
  window.history.replaceState({}, "", "/")
})

describe("App", () => {
  it("renders home and route errors without fetching", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { rerender } = renderApp()
    expect(screen.getByRole("heading", { name: "Morsel" })).toBeInTheDocument()
    window.location.hash = "#/s/short"
    fireEvent(window, new HashChangeEvent("hashchange"))
    expect(screen.getByRole("heading", { name: "Invalid share link" })).toBeInTheDocument()
    window.location.hash = "#/other"
    fireEvent(window, new HashChangeEvent("hashchange"))
    expect(screen.getByRole("heading", { name: "Share not found" })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    rerender(<div />)
  })

  it("loads a GitHub Gist route with the shared document controls", async () => {
    window.history.replaceState({}, "", `/gist/#${gist}`)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          files: {
            "README.md": {
              filename: "README.md",
              language: "Markdown",
              content: "# From Gist",
            },
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    renderApp()

    expect(screen.getByLabelText("Loading Gist")).toBeInTheDocument()
    expect(await screen.findByRole("heading", { name: "From Gist" })).toBeInTheDocument()
    expect(screen.getByText("GitHub Gist")).toBeInTheDocument()
    expect(screen.getByText("README.md")).toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Markdown file" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      `https://gist.github.com/${gist}`,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/gists/${gist}`,
      expect.objectContaining({ cache: "no-store", credentials: "omit" }),
    )
  })

  it("switches between every Markdown file in a Gist", async () => {
    window.history.replaceState({}, "", `/gist/#${gist}`)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            files: {
              "02-chart.md": {
                filename: "02-chart.md",
                language: "Markdown",
                content: "# Chart",
              },
              "notes.txt": { filename: "notes.txt", language: "Text", content: "Ignore" },
              "01-intro.md": {
                filename: "01-intro.md",
                language: "Markdown",
                content: "# Introduction",
              },
            },
          }),
          { status: 200 },
        ),
      ),
    )
    const { container } = renderApp()

    expect(await screen.findByRole("heading", { name: "Introduction" })).toBeInTheDocument()
    const user = userEvent.setup()
    const fileSelector = screen.getByRole("combobox", { name: "Markdown file" })
    expect(screen.getByRole("group", { name: "Gist files" })).toContainElement(fileSelector)
    expect(container.querySelector(".document-header")).not.toContainElement(fileSelector)
    expect(screen.getByText("2 files")).toBeInTheDocument()
    await user.click(fileSelector)
    await user.click(screen.getByRole("option", { name: "02-chart.md" }))

    expect(screen.getByRole("heading", { name: "Chart" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Introduction" })).not.toBeInTheDocument()
    expect(fileSelector).toHaveTextContent("02-chart.md")
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
    await user.click(screen.getByRole("button", { name: "Show raw Markdown" }))
    expect(container.querySelector(".raw-markdown")).toHaveTextContent("# Chart")
  })

  it("fetches exactly once in StrictMode and actions do not refetch", async () => {
    window.location.hash = `#/s/${token}`
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: "# Hello\n\nBody",
          created_at: "2026-01-01T00:00:00Z",
          view_count: 1,
          views_remaining: 2,
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined)
    const { container } = renderApp(true)
    expect(await screen.findByRole("heading", { name: "Morsel" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledOnce()

    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"))
    await user.click(screen.getByRole("button", { name: "Show raw Markdown" }))
    expect(container.querySelector(".raw-markdown")).toHaveTextContent("# Hello Body")
    await user.click(screen.getByRole("button", { name: "Copy Markdown" }))
    await screen.findByText(/Markdown copied/)
    expect(document.execCommand).toHaveBeenCalledWith("copy")
    await user.click(screen.getByRole("button", { name: "Copy URL" }))
    await user.click(screen.getByRole("button", { name: "Download Markdown" }))
    expect(anchorClick).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("clears the previous document when the share token changes", async () => {
    window.location.hash = `#/s/${token}`
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: "# First document",
            created_at: "2026-01-01T00:00:00Z",
            view_count: 1,
          }),
          { status: 200 },
        ),
      )
      .mockReturnValueOnce(new Promise<Response>(() => undefined))
    vi.stubGlobal("fetch", fetchMock)
    renderApp()
    expect(await screen.findByRole("heading", { name: "First document" })).toBeInTheDocument()

    window.location.hash = `#/s/${nextToken}`
    fireEvent(window, new HashChangeEvent("hashchange"))

    expect(screen.getByLabelText("Loading share")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "First document" })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    [404, "not_found", "Share not found"],
    [410, "expired", "Share expired"],
    [410, "revoked", "Share revoked"],
    [410, "view_limit_exhausted", "View limit reached"],
    [500, "internal_error", "Unable to load share"],
  ])("maps %s %s to an accessible state", async (status, code, title) => {
    window.location.hash = `#/s/${token}`
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code }), { status })),
    )
    renderApp()
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument()
  })

  it("restores persisted light and dark themes", () => {
    vi.stubGlobal("fetch", vi.fn())
    localStorage.setItem("morsel-theme", "light")
    const light = renderApp()
    expect(
      light.container.querySelector('[data-theme-mode="light"][data-appearance="light"]'),
    ).toBeInTheDocument()
    light.unmount()

    localStorage.setItem("morsel-theme", "dark")
    const dark = renderApp()
    expect(
      dark.container.querySelector('[data-theme-mode="dark"][data-appearance="dark"]'),
    ).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("falls back when theme storage is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    const { container } = renderApp()
    expect(container.querySelector('[data-theme-mode="system"]')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    await user.click(screen.getByRole("option", { name: "Dark" }))
    await waitFor(() =>
      expect(container.querySelector('[data-theme-mode="dark"]')).toBeInTheDocument(),
    )
    expect(fetch).not.toHaveBeenCalled()
    getItem.mockRestore()
    setItem.mockRestore()
  })

  it("follows live system theme changes without network activity", async () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined
    vi.stubGlobal("fetch", vi.fn())
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_type: string, next: (event: MediaQueryListEvent) => void) => {
        listener = next
      },
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
    const { container } = renderApp()
    expect(container.querySelector('[data-appearance="light"]')).toBeInTheDocument()
    listener?.({ matches: true } as MediaQueryListEvent)
    await waitFor(() =>
      expect(container.querySelector('[data-appearance="dark"]')).toBeInTheDocument(),
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it("has no automated accessibility violations on the home page", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const { container } = renderApp()
    const result = await axe.run(container)
    expect(result.violations).toEqual([])
  })
})
