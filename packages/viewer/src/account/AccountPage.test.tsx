import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AccountPage, type AccountSection } from "../pages/AccountPage"
import { ThemeProvider } from "../theme"
import type { Account, APIKey, Passkey } from "./accountApi"

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}))

const created = "2026-10-21T10:00:00Z"
const credential = {
  id: "credential",
  rawId: "credential",
  type: "public-key",
  response: { clientDataJSON: "data" },
}
const authenticationOptions = { challenge: "assertion-challenge", rpId: "localhost" }
const registrationOptions = {
  challenge: "registration-challenge",
  rp: { id: "localhost", name: "Morsel" },
}
let account: Account
let passkeys: Passkey[]
let keys: APIKey[]
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let fail: { path: string; status: number; code?: string; message?: string } | undefined

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function showPage(strict = false, section: AccountSection = "api-keys") {
  const page = (
    <ThemeProvider>
      <AccountPage section={section} />
    </ThemeProvider>
  )
  return render(strict ? <StrictMode>{page}</StrictMode> : page)
}

function callsTo(path: string) {
  return fetchMock.mock.calls.filter(([url]) => url === `/v1/${path}`)
}

beforeEach(() => {
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(true)
  vi.mocked(startAuthentication).mockResolvedValue(credential as never)
  vi.mocked(startRegistration).mockResolvedValue(credential as never)
  account = { setup_required: false, authenticated: false }
  passkeys = [{ id: "first", name: "Laptop", created_at: created }]
  keys = []
  fail = undefined
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).replace("/v1/", "")
    if (fail?.path === path)
      return json(
        { code: fail.code ?? "rejected", message: fail.message ?? "Request rejected." },
        fail.status,
      )
    if (path === "account") return json(account)
    if (path.startsWith("account/shares?")) return json({ items: [] })
    if (path === "passkeys" && init?.method === "GET") return json(passkeys)
    if (path === "api-keys" && init?.method === "GET") return json(keys)
    if (path.endsWith("/begin"))
      return json({
        publicKey: /auth\/(login|verify)\//.test(path)
          ? authenticationOptions
          : registrationOptions,
      })
    if (path.endsWith("/finish")) {
      if (/auth\/(setup|login|recover)\//.test(path))
        account = {
          setup_required: false,
          authenticated: true,
          csrf_token: "csrf-secret",
          verification_required: true,
        }
      if (path === "auth/passkey/finish")
        passkeys = [...passkeys, { id: "backup", name: "Phone", created_at: created }]
      return json({})
    }
    if (path === "auth/logout") {
      account = { setup_required: false, authenticated: false }
      return new Response(null, { status: 204 })
    }
    if (path === "api-keys" && init?.method === "POST") {
      const key = {
        id: "key/id",
        name: JSON.parse(String(init.body)).name,
        prefix: "morsel_test",
        created_at: created,
        revoked_at: null,
      }
      keys = [...keys, key]
      return json({ ...key, key: "raw-secret-only-once" }, 201)
    }
    if (path.startsWith("api-keys/") && init?.method === "DELETE") {
      keys = keys.map((key) => ({ ...key, revoked_at: created }))
      return new Response(null, { status: 204 })
    }
    if (path.startsWith("passkeys/") && init?.method === "DELETE") {
      passkeys = passkeys.filter(
        (key) => key.id !== decodeURIComponent(path.slice("passkeys/".length)),
      )
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected test request: ${path}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

async function signedIn(section: AccountSection = "api-keys") {
  account = {
    setup_required: false,
    authenticated: true,
    csrf_token: "csrf-secret",
    verification_required: true,
  }
  const result = showPage(false, section)
  await screen.findByRole("heading", {
    name: section === "security" ? "Passkeys" : section === "shares" ? "Manage shares" : "API keys",
  })
  return result
}

async function logout() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Account" }))
  await user.click(screen.getByRole("menuitem", { name: "Log out" }))
}

async function confirmRevoke() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Revoke API key CLI" }))
  await user.click(screen.getByRole("button", { name: "Confirm revoke API key" }))
}

async function createKey() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText("API key name"), "CLI")
  await user.click(screen.getByRole("button", { name: "Create API key" }))
  return screen.findByLabelText("New API key")
}

describe("AccountPage", () => {
  it("sets up the owner with a form token and raw registration credential, then refreshes account", async () => {
    account = { setup_required: true, authenticated: false }
    const { container } = showPage(true)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Setup token"), "operator-token")
    await user.type(screen.getByLabelText("Passkey name"), "Laptop")
    await user.click(screen.getByRole("button", { name: "Set up account" }))
    await screen.findByRole("heading", { name: "API keys" })
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: registrationOptions })
    expect(callsTo("auth/setup/begin")[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ token: "operator-token", name: "Laptop" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(callsTo("auth/setup/begin")[0]?.[1]?.headers).not.toHaveProperty("X-CSRF-Token")
    expect(JSON.parse(String(callsTo("auth/setup/finish")[0]?.[1]?.body))).toEqual(credential)
    expect(container).not.toHaveTextContent("operator-token")
    expect(callsTo("account").length).toBeGreaterThanOrEqual(2)
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
  })

  it("signs in without a username and offers recovery when setup is closed", async () => {
    showPage()
    const user = userEvent.setup()
    expect(await screen.findByLabelText("Recovery token")).toHaveAttribute("type", "password")
    expect(screen.queryByLabelText("Setup token")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Sign in with passkey" }))
    await screen.findByRole("heading", { name: "API keys" })
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: authenticationOptions })
    expect(callsTo("auth/login/begin")[0]?.[1]?.body).toBe("{}")
    expect(JSON.parse(String(callsTo("auth/login/finish")[0]?.[1]?.body))).toEqual(credential)
  })

  it("recovers with an operator token, a replacement passkey, and an API key review warning", async () => {
    showPage()
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Recovery token"), "recovery-secret")
    await user.type(screen.getByLabelText("Replacement passkey name"), "New device")
    await user.click(screen.getByRole("button", { name: "Recover account" }))
    await screen.findByRole("heading", { name: "API keys" })
    expect(callsTo("auth/recover/begin")[0]?.[1]?.body).toBe(
      JSON.stringify({ token: "recovery-secret", name: "New device" }),
    )
    expect(startRegistration).toHaveBeenCalledOnce()
    expect(screen.getByRole("status")).toHaveTextContent("Review your API keys")
  })

  it("verifies before creating, shows the raw key once, copies and dismisses it without storage", async () => {
    const user = userEvent.setup()
    const storage = vi.spyOn(Storage.prototype, "setItem")
    const logs = vi.spyOn(console, "log")
    await signedIn()
    const input = await createKey()
    expect(input).toHaveValue("raw-secret-only-once")
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/v1/auth/verify/finish")
    const verifyIndex = fetchMock.mock.calls.findIndex(([url]) => url === "/v1/auth/verify/finish")
    const createIndex = fetchMock.mock.calls.findIndex(
      ([url, init]) => url === "/v1/api-keys" && init?.method === "POST",
    )
    expect(verifyIndex).toBeLessThan(createIndex)
    for (const path of ["auth/verify/begin", "auth/verify/finish"]) {
      expect(callsTo(path)[0]?.[1]?.headers).toHaveProperty("X-CSRF-Token", "csrf-secret")
    }
    expect(fetchMock.mock.calls[createIndex]?.[1]?.headers).toHaveProperty(
      "X-CSRF-Token",
      "csrf-secret",
    )
    expect(screen.getByText(/shown only once/)).toBeInTheDocument()
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
    await user.click(screen.getByRole("button", { name: "Copy API key" }))
    await screen.findByText("API key copied.")
    expect(copy).toHaveBeenCalledWith("raw-secret-only-once")
    await user.click(screen.getByRole("button", { name: "Dismiss API key" }))
    expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
    expect(storage).not.toHaveBeenCalled()
    expect(logs).not.toHaveBeenCalled()
  })

  it("verifies key creation and revocation when the server requires it and encodes key IDs", async () => {
    await signedIn()
    await createKey()
    await confirmRevoke()
    await screen.findByText(/Created .* · Revoked/)
    expect(callsTo("auth/verify/begin")).toHaveLength(2)
    expect(callsTo("api-keys/key%2Fid")[0]?.[1]).toMatchObject({
      method: "DELETE",
      headers: { "X-CSRF-Token": "csrf-secret" },
    })
    expect(screen.queryByRole("button", { name: "Revoke API key CLI" })).not.toBeInTheDocument()
    expect(screen.getByText("API key revoked. Existing shares are unchanged.")).toBeInTheDocument()
  })

  it("adds and removes named backup passkeys with required verification and disables last removal", async () => {
    const { container } = await signedIn("security")
    const user = userEvent.setup()
    expect(screen.getByRole("button", { name: "Remove passkey Laptop" })).toBeDisabled()
    await user.type(screen.getByLabelText("Passkey name"), "Phone")
    await user.click(screen.getByRole("button", { name: "Add passkey" }))
    const remove = await screen.findByRole("button", { name: "Remove passkey Phone" })
    expect(remove).toBeEnabled()
    expect(callsTo("auth/passkey/begin")[0]?.[1]).toMatchObject({
      body: JSON.stringify({ name: "Phone" }),
      headers: { "X-CSRF-Token": "csrf-secret" },
    })
    expect(callsTo("auth/passkey/finish")[0]?.[1]?.body).toBe(JSON.stringify(credential))
    await user.click(remove)
    await waitFor(() => expect(screen.queryByText("Phone")).not.toBeInTheDocument())
    expect(callsTo("auth/verify/begin")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Remove passkey Laptop" })).toBeDisabled()
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
  })

  it("uses fresh server state to skip verification for multiple actions and keeps the raw key", async () => {
    await signedIn()
    account = { ...account, verification_required: false }
    await createKey()
    await confirmRevoke()
    await screen.findByText(/Created .* · Revoked/)
    expect(callsTo("account")).toHaveLength(3)
    expect(callsTo("auth/verify/begin")).toHaveLength(0)
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(startRegistration).not.toHaveBeenCalled()
    expect(screen.getByLabelText("New API key")).toHaveValue("raw-secret-only-once")
  })

  it("does not trust a stale UI flag when the current session needs verification", async () => {
    await signedIn()
    account = { ...account, verification_required: false }
    await createKey()
    account = { ...account, verification_required: true }
    await confirmRevoke()
    await screen.findByText(/Created .* · Revoked/)
    expect(callsTo("auth/verify/begin")).toHaveLength(1)
    expect(callsTo("auth/verify/finish")).toHaveLength(1)
    expect(callsTo("api-keys/key%2Fid")).toHaveLength(1)
  })

  it("requires verification when an older backend omits the freshness flag", async () => {
    await signedIn()
    delete account.verification_required
    await createKey()
    expect(startAuthentication).toHaveBeenCalledOnce()
    expect(callsTo("auth/verify/finish")).toHaveLength(1)
  })

  it.each([false, true])(
    "uses the preflight CSRF token with verification_required=%s",
    async (required) => {
      await signedIn()
      account = { ...account, csrf_token: "current-session-csrf", verification_required: required }
      await createKey()
      const creation = callsTo("api-keys").filter(([, init]) => init?.method === "POST")
      expect(creation).toHaveLength(1)
      expect(creation[0]?.[1]?.headers).toHaveProperty("X-CSRF-Token", "current-session-csrf")
      expect(callsTo("auth/verify/begin")).toHaveLength(required ? 1 : 0)
      if (required) {
        for (const path of ["auth/verify/begin", "auth/verify/finish"]) {
          expect(callsTo(path)[0]?.[1]?.headers).toHaveProperty(
            "X-CSRF-Token",
            "current-session-csrf",
          )
        }
      }
      await logout()
      await screen.findByRole("button", { name: "Sign in with passkey" })
      expect(callsTo("auth/logout")[0]?.[1]?.headers).toHaveProperty(
        "X-CSRF-Token",
        "current-session-csrf",
      )
    },
  )

  it.each(["signed out", "missing CSRF", "expired"])(
    "clears session state and does not mutate when preflight is %s",
    async (state) => {
      await signedIn()
      await createKey()
      const prompts = callsTo("auth/verify/begin").length
      if (state === "signed out") account = { setup_required: false, authenticated: false }
      if (state === "missing CSRF") account = { ...account, csrf_token: undefined }
      if (state === "expired") fail = { path: "account", status: 401 }
      await confirmRevoke()
      await screen.findByText("Your session expired. Sign in again.")
      expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
      expect(screen.queryByRole("heading", { name: "API keys" })).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeEnabled()
      expect(callsTo("auth/verify/begin")).toHaveLength(prompts)
      expect(callsTo("api-keys/key%2Fid")).toHaveLength(0)
    },
  )

  it.each([
    ["api key", "403"],
    ["api key", "network"],
    ["passkey", "403"],
    ["passkey", "network"],
  ])("does not retry %s creation after a %s failure", async (operation, failure) => {
    await signedIn(operation === "passkey" ? "security" : "api-keys")
    account = { ...account, verification_required: false }
    const path = operation === "api key" ? "api-keys" : "auth/passkey/finish"
    const original = fetchMock.getMockImplementation()
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `/v1/${path}` && init?.method === "POST") {
        account = { ...account, verification_required: true }
        if (failure === "network") throw new TypeError("connection lost after commit")
        return json({ code: "verification_required" }, 403)
      }
      if (!original) throw new Error("Missing fetch implementation")
      return original(input, init)
    })
    const user = userEvent.setup()
    await user.type(
      screen.getByLabelText(operation === "api key" ? "API key name" : "Passkey name"),
      "New credential",
    )
    await user.click(
      screen.getByRole("button", {
        name: operation === "api key" ? "Create API key" : "Add passkey",
      }),
    )
    await screen.findByText(failure === "403" ? /Authorization expired/ : /could not be completed/)
    expect(callsTo(path).filter(([, init]) => init?.method === "POST")).toHaveLength(1)
    expect(callsTo("auth/verify/begin")).toHaveLength(0)
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(startRegistration).toHaveBeenCalledTimes(operation === "passkey" ? 1 : 0)
    expect(callsTo("auth/passkey/begin")).toHaveLength(operation === "passkey" ? 1 : 0)
  })

  it("verifies on the next user retry after verification expires during a mutation", async () => {
    await signedIn()
    account = { ...account, verification_required: false }
    fail = { path: "api-keys", status: 403, code: "verification_required" }
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("API key name"), "CLI")
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await screen.findByText(/Authorization expired/)
    expect(callsTo("auth/verify/begin")).toHaveLength(0)
    account = { ...account, verification_required: true }
    fail = undefined
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await screen.findByLabelText("New API key")
    expect(callsTo("auth/verify/begin")).toHaveLength(1)
    expect(callsTo("api-keys").filter(([, init]) => init?.method === "POST")).toHaveLength(2)
  })

  it("keeps a displayed raw key when a later creation preflight fails", async () => {
    await signedIn()
    await createKey()
    fail = { path: "account", status: 500 }
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("API key name"), "Another key")
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await screen.findByText("Request rejected.")
    expect(screen.getByLabelText("New API key")).toHaveValue("raw-secret-only-once")
    expect(callsTo("api-keys").filter(([, init]) => init?.method === "POST")).toHaveLength(1)
  })

  it("clears the raw key on logout and uses CSRF", async () => {
    await signedIn()
    await createKey()
    await logout()
    await screen.findByRole("button", { name: "Sign in with passkey" })
    expect(screen.queryByDisplayValue("raw-secret-only-once")).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "API keys" })).not.toBeInTheDocument()
    expect(callsTo("auth/logout")[0]?.[1]?.headers).toHaveProperty("X-CSRF-Token", "csrf-secret")
  })

  it("clears raw keys even if logout fails and reports the failure", async () => {
    await signedIn()
    await createKey()
    fail = { path: "auth/logout", status: 500 }
    await logout()
    await screen.findByText("Request rejected.")
    expect(screen.queryByDisplayValue("raw-secret-only-once")).not.toBeInTheDocument()
  })

  it("handles unsupported browsers without attempting a ceremony", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false)
    showPage()
    const signIn = await screen.findByRole("button", { name: "Sign in with passkey" })
    expect(signIn).toBeDisabled()
    expect(screen.getByText(/This browser does not support passkeys/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Recover account" })).toBeDisabled()
    expect(startAuthentication).not.toHaveBeenCalled()
  })

  it("handles cancellation without finishing or mutating, then permits retry", async () => {
    vi.mocked(startAuthentication).mockRejectedValueOnce(
      new DOMException("cancelled", "NotAllowedError"),
    )
    await signedIn()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("API key name"), "CLI")
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await screen.findByText(/cancelled or timed out/)
    expect(callsTo("auth/verify/finish")).toHaveLength(0)
    expect(callsTo("api-keys").filter(([, init]) => init?.method === "POST")).toHaveLength(0)
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await screen.findByLabelText("New API key")
  })

  it("disables changes while busy and prevents duplicate prompts", async () => {
    let complete: ((value: never) => void) | undefined
    vi.mocked(startAuthentication).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    await signedIn()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("API key name"), "CLI")
    const button = screen.getByRole("button", { name: "Create API key" })
    await user.click(button)
    expect(button).toBeDisabled()
    expect(screen.getByRole("button", { name: "Account" })).toBeEnabled()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Verify your passkey to continue: Creating API key",
    )
    fireEvent.submit(button.closest("form") as HTMLFormElement)
    expect(startAuthentication).toHaveBeenCalledOnce()
    complete?.(credential as never)
    await screen.findByLabelText("New API key")
  })

  it("handles session expiry and clears all account secrets", async () => {
    await signedIn()
    await createKey()
    fail = { path: "auth/verify/begin", status: 401 }
    await confirmRevoke()
    await screen.findByText("Your session expired. Sign in again.")
    expect(screen.queryByDisplayValue("raw-secret-only-once")).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "API keys" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeEnabled()
  })

  it("refreshes stale CSRF state without retrying a failed mutation", async () => {
    await signedIn()
    fail = { path: "auth/verify/begin", status: 403 }
    account = { ...account, csrf_token: "new-csrf" }
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("API key name"), "CLI")
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await screen.findByText(/Authorization expired/)
    expect(callsTo("api-keys").filter(([, init]) => init?.method === "POST")).toHaveLength(0)
    fail = undefined
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await screen.findByLabelText("New API key")
    expect(callsTo("auth/verify/begin")[1]?.[1]?.headers).toHaveProperty("X-CSRF-Token", "new-csrf")
  })

  it("reports server last-passkey conflicts and reloads the remaining passkey", async () => {
    passkeys.push({ id: "backup", name: "Phone", created_at: created })
    await signedIn("security")
    passkeys = passkeys.slice(0, 1)
    fail = { path: "passkeys/first", status: 409, message: "Cannot remove the last passkey." }
    await userEvent.setup().click(screen.getByRole("button", { name: "Remove passkey Laptop" }))
    await screen.findByText("Cannot remove the last passkey.")
    expect(screen.getByRole("button", { name: "Remove passkey Laptop" })).toBeDisabled()
    expect(screen.queryByText("Phone")).not.toBeInTheDocument()
  })

  it("reloads account state if another browser closes setup", async () => {
    account = { setup_required: true, authenticated: false }
    showPage()
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Setup token"), "old-token")
    await user.type(screen.getByLabelText("Passkey name"), "Laptop")
    account = { setup_required: false, authenticated: false }
    fail = { path: "auth/setup/begin", status: 409, message: "Setup is closed." }
    await user.click(screen.getByRole("button", { name: "Set up account" }))
    await screen.findByText("Setup is closed.")
    expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeEnabled()
    expect(screen.queryByLabelText("Setup token")).not.toBeInTheDocument()
  })

  it("handles initial network failure with retry and clipboard failure without unhandled promises", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
    showPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Retry account" }))
    await user.click(await screen.findByRole("button", { name: "Sign in with passkey" }))
    await screen.findByRole("heading", { name: "API keys" })
    await createKey()
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"))
    await user.click(screen.getByRole("button", { name: "Copy API key" }))
    await screen.findByText("Could not copy API key. Select and copy it manually.")
    expect(screen.getByLabelText("New API key")).toHaveValue("raw-secret-only-once")
  })

  it("defaults to security and does not request API keys or shares", async () => {
    account = { authenticated: true, setup_required: false, csrf_token: "csrf" }
    fail = { path: "account/shares?status=all", status: 500 }
    render(
      <ThemeProvider>
        <AccountPage />
      </ThemeProvider>,
    )
    await screen.findByRole("heading", { name: "Passkeys" })
    expect(callsTo("passkeys")).toHaveLength(1)
    expect(callsTo("api-keys")).toHaveLength(0)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("account/shares"))).toBe(false)
    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute("aria-current", "page")
    expect(
      screen.getByRole("button", { name: "Remove passkey Laptop" }),
    ).toHaveAccessibleDescription(
      "You cannot remove your last passkey. Add a backup passkey first.",
    )
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })

  it("requires explicit API key confirmation, supports cancellation, and restores focus", async () => {
    keys = [
      { id: "key/id", name: "CLI", prefix: "morsel_prefix", created_at: created, revoked_at: null },
    ]
    await signedIn()
    const user = userEvent.setup()
    const revoke = screen.getByRole("button", { name: "Revoke API key CLI" })
    await user.click(revoke)
    expect(screen.getByRole("heading", { name: "Revoke API key CLI?" })).toBeInTheDocument()
    expect(screen.getByText("morsel_prefix", { selector: "section code" })).toBeInTheDocument()
    expect(screen.getByText(/Integrations using this key will lose access/)).toHaveTextContent(
      "Existing shares remain available and are not changed.",
    )
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()
    expect(callsTo("account")).toHaveLength(1)
    expect(callsTo("api-keys/key%2Fid")).toHaveLength(0)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(revoke).toHaveFocus()
    expect(screen.queryByRole("button", { name: "Confirm revoke API key" })).not.toBeInTheDocument()
    expect(callsTo("auth/verify/begin")).toHaveLength(0)
  })

  it("reports the actual create step after verification completes", async () => {
    const original = fetchMock.getMockImplementation()
    let finish: ((value: Response) => void) | undefined
    fetchMock.mockImplementation((input, init) => {
      if (input === "/v1/api-keys" && init?.method === "POST")
        return new Promise((resolve) => {
          finish = resolve
        })
      if (!original) throw new Error("Missing fetch implementation")
      return original(input, init)
    })
    await signedIn()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("API key name"), "CLI")
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Creating API key…"))
    await waitFor(() => expect(callsTo("auth/verify/finish")).toHaveLength(1))
    expect(screen.getByRole("status")).not.toHaveTextContent("prompt")
    await act(async () => {
      finish?.(json({ key: "late-key" }, 201))
    })
    await screen.findByLabelText("New API key")
  })

  it("loads only the active list and ignores an obsolete list response after section navigation", async () => {
    const original = fetchMock.getMockImplementation()
    let finish: ((value: Response) => void) | undefined
    fetchMock.mockImplementation((input, init) => {
      if (input === "/v1/api-keys" && init?.method === "GET")
        return new Promise((resolve) => {
          finish = resolve
        })
      if (!original) throw new Error("Missing fetch implementation")
      return original(input, init)
    })
    account = { authenticated: true, setup_required: false, csrf_token: "csrf" }
    const page = showPage()
    await waitFor(() => expect(callsTo("api-keys")).toHaveLength(1))
    const signal = callsTo("api-keys")[0]?.[1]?.signal
    page.rerender(
      <ThemeProvider>
        <AccountPage section="security" />
      </ThemeProvider>,
    )
    await screen.findByRole("heading", { name: "Passkeys" })
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      finish?.(
        json([{ id: "late", name: "Private key", prefix: "late-prefix", created_at: created }]),
      )
    })
    expect(screen.queryByText("Private key")).not.toBeInTheDocument()
    expect(callsTo("passkeys")).toHaveLength(1)
    expect(callsTo("api-keys")).toHaveLength(1)
  })

  it("does not restore a raw key from a creation response after section navigation", async () => {
    account = {
      authenticated: true,
      setup_required: false,
      csrf_token: "csrf",
      verification_required: false,
    }
    const original = fetchMock.getMockImplementation()
    let finish: ((value: Response) => void) | undefined
    fetchMock.mockImplementation((input, init) => {
      if (input === "/v1/api-keys" && init?.method === "POST")
        return new Promise((resolve) => {
          finish = resolve
        })
      if (!original) throw new Error("Missing fetch implementation")
      return original(input, init)
    })
    const page = showPage()
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("API key name"), "CLI")
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await waitFor(() =>
      expect(callsTo("api-keys").filter(([, init]) => init?.method === "POST")).toHaveLength(1),
    )
    const signal = callsTo("api-keys").find(([, init]) => init?.method === "POST")?.[1]?.signal
    page.rerender(
      <ThemeProvider>
        <AccountPage section="security" />
      </ThemeProvider>,
    )
    await screen.findByRole("heading", { name: "Passkeys" })
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      finish?.(json({ key: "late-secret" }, 201))
    })
    page.rerender(
      <ThemeProvider>
        <AccountPage section="api-keys" />
      </ThemeProvider>,
    )
    await screen.findByRole("heading", { name: "API keys" })
    expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
    expect(page.container).not.toHaveTextContent("late-secret")
  })

  it("clears a one-time key and confirmation when the active key list loses authorization", async () => {
    await signedIn()
    await createKey()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Revoke API key CLI" }))
    fail = { path: "api-keys", status: 401 }
    account = { ...account, verification_required: false }
    await user.click(screen.getByRole("button", { name: "Confirm revoke API key" }))
    await screen.findByText("Your session expired. Sign in again.")
    expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Confirm revoke API key" })).not.toBeInTheDocument()
  })

  it("aborts an active verification on logout and ignores its late browser result", async () => {
    let complete: ((value: never) => void) | undefined
    vi.mocked(startAuthentication).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    await signedIn()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("API key name"), "CLI")
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce())
    await logout()
    await screen.findByRole("button", { name: "Sign in with passkey" })
    expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce()
    await act(async () => {
      complete?.(credential as never)
    })
    expect(callsTo("auth/verify/finish")).toHaveLength(0)
    expect(callsTo("api-keys").filter(([, init]) => init?.method === "POST")).toHaveLength(0)
  })

  it.each(["setup", "login", "recover"] as const)(
    "does not finish %s after section navigation",
    async (operation) => {
      let complete: ((value: never) => void) | undefined
      if (operation === "setup") account = { setup_required: true, authenticated: false }
      vi.mocked(
        operation === "login" ? startAuthentication : startRegistration,
      ).mockReturnValueOnce(
        new Promise<never>((resolve) => {
          complete = resolve
        }),
      )
      const page = showPage(false, "shares")
      const user = userEvent.setup()
      if (operation === "setup") {
        await user.type(await screen.findByLabelText("Setup token"), "secret")
        await user.type(screen.getByLabelText("Passkey name"), "Device")
        await user.click(screen.getByRole("button", { name: "Set up account" }))
      } else if (operation === "recover") {
        await user.type(await screen.findByLabelText("Recovery token"), "secret")
        await user.type(screen.getByLabelText("Replacement passkey name"), "Device")
        await user.click(screen.getByRole("button", { name: "Recover account" }))
      } else {
        await user.click(await screen.findByRole("button", { name: "Sign in with passkey" }))
      }
      await waitFor(() =>
        expect(
          operation === "login" ? startAuthentication : startRegistration,
        ).toHaveBeenCalledOnce(),
      )
      page.rerender(
        <ThemeProvider>
          <AccountPage section="security" />
        </ThemeProvider>,
      )
      await screen.findByRole("heading", { name: "Morsel account" })
      await act(async () => {
        complete?.(credential as never)
      })
      expect(callsTo(`auth/${operation}/finish`)).toHaveLength(0)
      expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce()
    },
  )

  it("does not finish a ceremony after leaving the account page", async () => {
    let complete: ((value: never) => void) | undefined
    vi.mocked(startAuthentication).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    const page = await signedIn()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("API key name"), "CLI")
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledOnce())
    page.unmount()
    expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce()
    complete?.(credential as never)
    await waitFor(() => expect(callsTo("auth/verify/finish")).toHaveLength(0))
  })
})
