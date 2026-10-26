import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../App"
import type { Account } from "../account/accountApi"
import { authenticationURL, navigate } from "../navigation"
import { ThemeProvider } from "../theme"

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}))

let account: Account
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const destinations = ["/manage/shares", "/manage/api-keys", "/account"]
const json = (value: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      value && typeof value === "object" && "authenticated" in value && value.authenticated
        ? { account_id: "10000000-0000-4000-8000-000000000001", display_name: "Owner", ...value }
        : value,
    ),
    { status, headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" } },
  )
function show(path: string) {
  window.history.replaceState({}, "", path)
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  )
}

beforeEach(() => {
  account = { authenticated: false, setup_required: false }
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true)
  vi.mocked(startAuthentication).mockResolvedValue({ id: "credential" } as never)
  vi.mocked(startRegistration).mockResolvedValue({ id: "credential" } as never)
  fetchMock = vi.fn<typeof fetch>(async (input) => {
    const path = String(input)
    if (path === "/v1/account") return json(account)
    if (path.endsWith("/begin")) return json({ publicKey: {} })
    if (path.endsWith("/finish")) {
      account = { authenticated: true, setup_required: false, csrf_token: "csrf" }
      return json({})
    }
    if (path.startsWith("/v1/account/shares?")) return json({ items: [], matching_count: 0 })
    if (path === "/v1/passkeys" || path === "/v1/api-keys") return json([])
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

describe("authentication routes", () => {
  it.each(destinations)(
    "creates an invited account with a separate account name and returns to %s",
    async (destination) => {
      show(authenticationURL("invite", destination))
      const user = userEvent.setup()
      await user.type(await screen.findByLabelText("Invitation token"), "one-time-invitation")
      await user.type(screen.getByLabelText("Account name"), "Research team")
      await user.type(screen.getByLabelText("Passkey name"), "Laptop")
      await user.click(screen.getByRole("button", { name: "Create account" }))
      await screen.findByRole("navigation", { name: "Management sections" })
      expect(window.location.pathname).toBe(destination)
      expect(
        JSON.parse(
          String(fetchMock.mock.calls.find(([url]) => url === "/v1/auth/invite/begin")?.[1]?.body),
        ),
      ).toEqual({
        token: "one-time-invitation",
        name: "Laptop",
        display_name: "Research team",
      })
      expect(window.location.href).not.toContain("one-time-invitation")
      expect(startRegistration).toHaveBeenCalledOnce()
    },
  )

  it("bounds invited account names by UTF-8 bytes", async () => {
    show("/invite")
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Invitation token"), "invitation")
    await user.type(screen.getByLabelText("Passkey name"), "Device")
    await user.type(screen.getByLabelText("Account name"), "界".repeat(67))
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled()
    expect(startRegistration).not.toHaveBeenCalled()
  })

  for (const mode of ["login", "setup", "recover"] as const) {
    it.each(destinations)(
      `returns from ${mode} to %s without exposing management before authentication`,
      async (destination) => {
        account.setup_required = mode === "setup"
        show(mode === "recover" ? authenticationURL(mode, destination) : destination)
        const user = userEvent.setup()
        const title =
          mode === "login" ? "Sign in" : mode === "setup" ? "Set up account" : "Recover account"
        await screen.findByRole("heading", { name: title })
        expect(window.location.pathname).toBe(`/${mode}`)
        expect(screen.getByRole("heading", { name: title })).toHaveFocus()
        expect(
          screen.queryByRole("navigation", { name: "Management sections" }),
        ).not.toBeInTheDocument()
        expect(
          fetchMock.mock.calls.filter(([url]) =>
            /\/v1\/(passkeys|api-keys|account\/shares)/.test(String(url)),
          ),
        ).toHaveLength(0)
        if (mode === "login") {
          expect(screen.queryByLabelText("Recovery token")).not.toBeInTheDocument()
          await user.click(screen.getByRole("button", { name: "Sign in with passkey" }))
        } else {
          await user.type(
            screen.getByLabelText(mode === "setup" ? "Setup token" : "Recovery token"),
            "operator-secret",
          )
          await user.type(
            screen.getByLabelText(mode === "setup" ? "Passkey name" : "Replacement passkey name"),
            "Device",
          )
          await user.click(screen.getByRole("button", { name: title }))
        }
        await screen.findByRole("navigation", { name: "Management sections" })
        expect(window.location.pathname).toBe(destination)
        expect(window.location.search).toBe("")
        expect(window.location.href).not.toContain("operator-secret")
      },
    )
  }

  it.each(["login", "recover", "setup"] as const)(
    "redirects authenticated /%s visits to the validated destination",
    async (mode) => {
      account.authenticated = true
      show(authenticationURL(mode, "/account"))
      await screen.findByRole("heading", { name: "Passkeys" })
      expect(window.location.pathname).toBe("/account")
    },
  )

  it.each(["/login", "/recover", "/manage/api-keys"])(
    "requires initial setup when entering %s",
    async (path) => {
      account.setup_required = true
      show(path)
      await screen.findByLabelText("Setup token")
      expect(window.location.pathname).toBe("/setup")
      expect(screen.queryByLabelText("Recovery token")).not.toBeInTheDocument()
    },
  )

  it("rejects a closed setup route and preserves the destination", async () => {
    show(authenticationURL("setup", "/account"))
    await screen.findByRole("heading", { name: "Sign in" })
    expect(window.location.pathname).toBe("/login")
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/account")
    expect(screen.queryByLabelText("Setup token")).not.toBeInTheDocument()
  })

  it("tracks same-path query navigation and keeps the destination through recovery links", async () => {
    show(authenticationURL("login", "/manage/shares"))
    await screen.findByRole("heading", { name: "Sign in" })
    act(() => navigate(authenticationURL("login", "/account")))
    const user = userEvent.setup()
    await user.click(screen.getByRole("link", { name: "Recover account" }))
    expect(window.location.pathname).toBe("/recover")
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/account")
    await user.click(screen.getByRole("link", { name: "Back to sign in" }))
    await user.click(screen.getByRole("button", { name: "Sign in with passkey" }))
    await screen.findByRole("heading", { name: "Passkeys" })
    expect(window.location.pathname).toBe("/account")
  })

  it.each(["?next=https://evil.example", "?next=/account&next=/account", "?next=%"])(
    "uses Shares after signing in with invalid destination %s",
    async (search) => {
      show(`/login${search}`)
      await userEvent
        .setup()
        .click(await screen.findByRole("button", { name: "Sign in with passkey" }))
      await screen.findByRole("heading", { name: "Shares" })
      expect(window.location.pathname).toBe("/manage/shares")
    },
  )

  it("shows no protected content while checking the session and ignores late state after leaving", async () => {
    let resolve: ((response: Response) => void) | undefined
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    show("/account")
    expect(screen.getByLabelText("Loading account")).toBeInTheDocument()
    expect(
      screen.queryByRole("navigation", { name: "Management sections" }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sign in with passkey" })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("link", { name: "Morsel home" }))
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    await act(async () => resolve?.(json({ authenticated: true, setup_required: false })))
    expect(screen.getByRole("heading", { name: "Open a document" })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not turn server failures into sign-in and permits retry", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "Unavailable" }, 503))
    show("/manage/api-keys")
    await screen.findByText("Unavailable")
    expect(window.location.pathname).toBe("/manage/api-keys")
    expect(screen.queryByRole("button", { name: "Sign in with passkey" })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry account" }))
    await screen.findByRole("heading", { name: "Sign in" })
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/manage/api-keys")
  })

  it("keeps cancellation on login and permits a second attempt", async () => {
    vi.mocked(startAuthentication).mockRejectedValueOnce(
      new DOMException("Cancelled", "NotAllowedError"),
    )
    show("/account")
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Sign in with passkey" }))
    await screen.findByText(/cancelled or timed out/)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/finish"))).toBe(false)
    await user.click(screen.getByRole("button", { name: "Sign in with passkey" }))
    await waitFor(() => expect(window.location.pathname).toBe("/account"))
  })
})
