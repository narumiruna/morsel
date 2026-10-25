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
import { App } from "./App"
import { clearRequestCacheForTests } from "./api"
import { ThemeProvider } from "./theme"

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }),
  },
}))

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
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
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true)
  vi.mocked(startAuthentication).mockResolvedValue({ id: "credential" } as never)
  clearRequestCacheForTests()
  window.history.replaceState({}, "", "/")
})

function managementFetch(initiallySignedIn = true) {
  let authenticated = initiallySignedIn
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).replace("/v1/", "")
    let body: unknown
    if (path === "account")
      body = {
        authenticated,
        setup_required: false,
        csrf_token: "csrf",
        verification_required: false,
      }
    else if (path === "passkeys")
      body = [{ id: "first", name: "Laptop", created_at: "2026-10-21T10:00:00Z" }]
    else if (path === "api-keys")
      body = init?.method === "POST" ? { id: "key", key: "raw-one-time-key" } : []
    else if (path.startsWith("account/shares?")) body = { items: [], matching_count: 0 }
    else if (path === "auth/login/begin") body = { publicKey: { challenge: "challenge" } }
    else if (path === "auth/login/finish") {
      authenticated = true
      body = {}
    } else throw new Error(`Unexpected request: ${path}`)
    return new Response(JSON.stringify(body))
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

async function newKey() {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText("API key name"), "CLI")
  await user.click(screen.getByRole("button", { name: "Create API key" }))
  await screen.findByLabelText("New API key")
}

describe("App", () => {
  it("renders home and route errors without fetching", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { rerender } = renderApp()
    expect(screen.getByRole("heading", { name: "Open a document" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("href", "/manage/shares")
    expect(screen.getByRole("link", { name: "Morsel home" })).toHaveAttribute("href", "/")
    window.location.hash = "#/s/short"
    fireEvent(window, new HashChangeEvent("hashchange"))
    expect(screen.getByRole("heading", { name: "Invalid share link" })).toBeInTheDocument()
    window.location.hash = "#/other"
    fireEvent(window, new HashChangeEvent("hashchange"))
    expect(screen.getByRole("heading", { name: "Share not found" })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    rerender(<div />)
  })

  it("loads the account page only at the explicit account path", async () => {
    window.history.replaceState({}, "", "/account")
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ setup_required: false, authenticated: false })),
      )
    vi.stubGlobal("fetch", fetchMock)
    renderApp()
    expect(screen.getByLabelText("Loading account")).toBeInTheDocument()
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(window.location.pathname).toBe("/login")
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/account")
    expect(
      screen.queryByRole("navigation", { name: "Management sections" }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/account",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    )
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
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test")
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

  it.each([
    ["/manage/shares", "Manage shares"],
    ["/manage/api-keys", "API keys"],
  ])(
    "keeps the requested %s section through login and ignores free-form return URLs",
    async (path, heading) => {
      window.history.replaceState({}, "", `${path}?returnTo=https://example.invalid/`)
      const fetchMock = managementFetch(false)
      renderApp()
      const user = userEvent.setup()
      await user.click(await screen.findByRole("button", { name: "Sign in with passkey" }))
      await screen.findByRole("heading", { name: heading })
      expect(window.location.pathname).toBe(path)
      expect(startAuthentication).toHaveBeenCalledOnce()
      const urls = fetchMock.mock.calls.map(([url]) => String(url))
      expect(urls).not.toContain("/v1/passkeys")
      if (path === "/manage/shares") expect(urls).not.toContain("/v1/api-keys")
      else expect(urls.some((url) => url.startsWith("/v1/account/shares"))).toBe(false)
    },
  )

  it("warns before section navigation discards a key, keeps it on cancellation, and never stores it", async () => {
    window.history.replaceState({}, "", "/manage/api-keys")
    managementFetch()
    const storage = vi.spyOn(Storage.prototype, "setItem")
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    renderApp()
    await newKey()
    const user = userEvent.setup()
    const unload = new Event("beforeunload", { cancelable: true })
    expect(window.dispatchEvent(unload)).toBe(false)
    await user.click(screen.getByRole("link", { name: "Security" }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(window.location.pathname).toBe("/manage/api-keys")
    expect(screen.getByLabelText("New API key")).toHaveValue("raw-one-time-key")
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole("link", { name: "Security" }))
    await screen.findByRole("heading", { name: "Passkeys" })
    expect(window.location.pathname).toBe("/account")
    expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute("aria-current", "page")
    await user.click(screen.getByRole("link", { name: "API keys" }))
    await screen.findByRole("heading", { name: "API keys" })
    expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
    expect(storage).not.toHaveBeenCalled()
  })

  it("safely cancels and accepts browser back with a one-time key, then supports forward", async () => {
    window.history.replaceState({}, "", "/account")
    managementFetch()
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    renderApp()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("link", { name: "API keys" }))
    await newKey()
    act(() => window.history.back())
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    await waitFor(() => expect(window.location.pathname).toBe("/manage/api-keys"))
    expect(screen.getByLabelText("New API key")).toHaveValue("raw-one-time-key")
    confirm.mockReturnValue(true)
    act(() => window.history.back())
    await screen.findByRole("heading", { name: "Passkeys" })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(window.location.pathname).toBe("/account")
    act(() => window.history.forward())
    await screen.findByRole("heading", { name: "API keys" })
    expect(window.location.pathname).toBe("/manage/api-keys")
    expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
  })

  it("aborts login on a navigation link and ignores late browser completion", async () => {
    window.history.replaceState({}, "", "/manage/shares")
    const fetchMock = managementFetch(false)
    let complete: ((value: never) => void) | undefined
    vi.mocked(startAuthentication).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    renderApp()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Sign in with passkey" }))
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce())
    await user.click(screen.getByRole("link", { name: "Recover account" }))
    await screen.findByRole("heading", { name: "Recover account" })
    expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce()
    await act(async () => {
      complete?.({ id: "late" } as never)
    })
    expect(fetchMock.mock.calls.some(([url]) => url === "/v1/auth/login/finish")).toBe(false)
  })

  it("uses one public header with a theme control and an accessible account menu only in management", async () => {
    window.history.replaceState({}, "", "/account")
    managementFetch()
    const { container } = renderApp()
    const user = userEvent.setup()
    await screen.findByRole("heading", { name: "Passkeys" })
    expect(screen.getAllByRole("banner")).toHaveLength(1)
    expect(
      within(screen.getByRole("banner")).getByRole("combobox", { name: "Theme" }),
    ).toBeInTheDocument()
    const menu = screen.getByRole("button", { name: "Account" })
    await user.click(menu)
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(menu).toHaveFocus()
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
    await user.click(screen.getByRole("link", { name: "Morsel home" }))
    expect(screen.queryByRole("button", { name: "Account" })).not.toBeInTheDocument()
  })

  it("opens the bundled example through the header shell without requests", async () => {
    window.history.replaceState({}, "", "/example")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderApp()
    expect(screen.getByRole("banner")).toBeInTheDocument()
    expect(screen.getByRole("article")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Account" })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([`/s/${token}`, `/#/s/${token}`])(
    "preserves document anchors and non-app links at %s while routing document links",
    async (path) => {
      window.history.replaceState({}, "", path)
      const fetchMock = vi.fn<typeof fetch>(
        async (input) =>
          new Response(
            JSON.stringify({
              content:
                input === `/v1/shares/${nextToken}`
                  ? "# Second document"
                  : `# First document\n\n[Section](#section)\n\n[API file](/v1/files/notes.md)\n\n[Asset](/logo.svg)\n\n[Next document](/s/${nextToken})`,
              created_at: "2026-01-01T00:00:00Z",
              view_count: 1,
            }),
          ),
      )
      vi.stubGlobal("fetch", fetchMock)
      renderApp()
      await screen.findByRole("heading", { name: "First document" })
      for (const name of ["Section", "API file", "Asset"]) {
        let prevented: boolean | undefined
        document.addEventListener(
          "click",
          (event) => {
            prevented = event.defaultPrevented
            // Stop jsdom's native navigation after checking the application handler.
            event.preventDefault()
          },
          { once: true },
        )
        fireEvent.click(screen.getByRole("link", { name }))
        // Fragment readers scroll locally so document anchors cannot replace the capability.
        expect(prevented).toBe(path.startsWith("/#") && name === "Section")
      }
      if (path.startsWith("/#")) {
        expect(window.location.hash).toBe(`#/s/${token}`)
      } else {
        window.history.pushState({}, "", `${window.location.pathname}#section`)
        fireEvent(window, new HashChangeEvent("hashchange"))
      }
      expect(screen.getByRole("heading", { name: "First document" })).toBeInTheDocument()
      expect(fetchMock).toHaveBeenCalledOnce()
      await userEvent.setup().click(screen.getByRole("link", { name: "Next document" }))
      await screen.findByRole("heading", { name: "Second document" })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("/v1/shares/"))).toBe(
        true,
      )
    },
  )

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
