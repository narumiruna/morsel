import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AccountPage } from "../pages/AccountPage"
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
let fail: { path: string; status: number; message?: string } | undefined

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function showPage(strict = false) {
  const page = (
    <ThemeProvider>
      <AccountPage />
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
      return json({ code: "rejected", message: fail.message ?? "Request rejected." }, fail.status)
    if (path === "account") return json(account)
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
        account = { setup_required: false, authenticated: true, csrf_token: "csrf-secret" }
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

async function signedIn() {
  account = { setup_required: false, authenticated: true, csrf_token: "csrf-secret" }
  const result = showPage()
  await screen.findByRole("heading", { name: "API keys" })
  return result
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

  it("re-verifies for every key creation and revocation and encodes key IDs", async () => {
    await signedIn()
    await createKey()
    await userEvent.setup().click(screen.getByRole("button", { name: "Revoke API key CLI" }))
    await screen.findByText(/Revoked/)
    expect(callsTo("auth/verify/begin")).toHaveLength(2)
    expect(callsTo("api-keys/key%2Fid")[0]?.[1]).toMatchObject({
      method: "DELETE",
      headers: { "X-CSRF-Token": "csrf-secret" },
    })
    expect(screen.queryByRole("button", { name: "Revoke API key CLI" })).not.toBeInTheDocument()
    expect(screen.getByText("API key revoked. Existing shares are unchanged.")).toBeInTheDocument()
  })

  it("adds and removes named backup passkeys after separate verification and disables last removal", async () => {
    const { container } = await signedIn()
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

  it("clears the raw key on logout and uses CSRF", async () => {
    await signedIn()
    await createKey()
    await userEvent.setup().click(screen.getByRole("button", { name: "Log out" }))
    await screen.findByRole("button", { name: "Sign in with passkey" })
    expect(screen.queryByDisplayValue("raw-secret-only-once")).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "API keys" })).not.toBeInTheDocument()
    expect(callsTo("auth/logout")[0]?.[1]?.headers).toHaveProperty("X-CSRF-Token", "csrf-secret")
  })

  it("clears raw keys even if logout fails and reports the failure", async () => {
    await signedIn()
    await createKey()
    fail = { path: "auth/logout", status: 500 }
    await userEvent.setup().click(screen.getByRole("button", { name: "Log out" }))
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
    expect(screen.getByRole("button", { name: "Log out" })).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent("Working")
    fireEvent.submit(button.closest("form") as HTMLFormElement)
    expect(startAuthentication).toHaveBeenCalledOnce()
    complete?.(credential as never)
    await screen.findByLabelText("New API key")
  })

  it("handles session expiry and clears all account secrets", async () => {
    await signedIn()
    await createKey()
    fail = { path: "auth/verify/begin", status: 401 }
    await userEvent.setup().click(screen.getByRole("button", { name: "Revoke API key CLI" }))
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
    await signedIn()
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
    await screen.findByText(/could not be completed/)
    expect(screen.getByLabelText("New API key")).toHaveValue("raw-secret-only-once")
  })

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
