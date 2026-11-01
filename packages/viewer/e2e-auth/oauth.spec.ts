import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import {
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
  type Response,
  test,
} from "@playwright/test"

type Actor = {
  context: BrowserContext
  page: Page
  cdp: CDPSession
  id: string
  name: string
}
type Client = { id: string; name: string; redirect: string }
type Flow = {
  client: Client
  handle: string
  consent: string
  state: string
  verifier: string
  redirect: string
  scope: string
}
type Tokens = { access_token: string; refresh_token?: string; scope: string; expires_in: number }
type Grant = {
  id: string
  client_id: string
  client_name: string
  resource: string
  scope: string
  revoked_at: string | null
}
type Issued = { flow: Flow; code: string; tokens: Tokens; grant: Grant }

const helper = process.env.MORSEL_AUTH_TEST_HELPER as string
const accountCLI = process.env.MORSEL_AUTH_TEST_ACCOUNT as string
const offlineScope = "mcp:shares offline_access"
const invalidRequest =
  "This connection request is no longer valid. Restart the connection from your app."
const credentials = new Set<string>()
const browserRequests: { url: string; referrer: string }[] = []
const browserMessages: string[] = []
const actors: Actor[] = []
let origin: string
let native: APIRequestContext
let alpha: Actor
let beta: Actor
let clientA: Client
let clientB: Client
let callbackServer: Server
let callbackOrigin: string
let callbackURI: string
const callbacks: { url: string; referrer: string }[] = []
let rpcID = 0

function command(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.once("error", () => reject(new Error("OAuth fixture command could not start")))
    child.once("exit", (code) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error("OAuth fixture command failed (credential details suppressed)"))
    })
    child.stdin.end(input)
  })
}

function remember(value: string) {
  credentials.add(value)
  return value
}

function credential(value: unknown, prefix: "moc_" | "moa_" | "mor_") {
  expect(typeof value === "string" && new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`).test(value)).toBe(
    true,
  )
  return remember(value as string)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function observe(context: BrowserContext) {
  context.on("request", (request) => {
    browserRequests.push({ url: request.url(), referrer: request.headers().referer ?? "" })
  })
  context.on("page", (page) => {
    page.on("console", (message) => browserMessages.push(message.text()))
    page.on("pageerror", (error) => browserMessages.push(error.message))
  })
}

async function virtualPasskey(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return cdp
}

async function account(actor: Actor) {
  const response = await actor.page.request.get("/v1/account")
  expect(response.status()).toBe(200)
  expect(response.headers()["cache-control"]).toContain("no-store")
  const result = await response.json()
  if (result.authenticated)
    expect(response.headers()["x-morsel-account-id"]).toBe(result.account_id)
  return result
}

async function enrolled(browser: Browser, name: string) {
  const context = await browser.newContext({ baseURL: origin })
  observe(context)
  const page = await context.newPage()
  const actor: Actor = { context, page, cdp: await virtualPasskey(context, page), id: "", name }
  actors.push(actor)
  const token = remember(await command(accountCLI, ["-kind", "invite"]))
  await page.goto("/invite")
  await page.getByLabel("Invitation token", { exact: true }).fill(token)
  await page.getByLabel("Account name", { exact: true }).fill(name)
  await page.getByLabel("Passkey name", { exact: true }).fill(`${name} OAuth passkey`)
  await page.bringToFront()
  await page.getByRole("button", { name: "Create account", exact: true }).click()
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
  const state = await account(actor)
  expect(state.display_name).toBe(name)
  expect(state.role).toBe("user")
  actor.id = state.account_id
  return actor
}

async function login(actor: Actor, destination = "/account") {
  await actor.page.bringToFront()
  await actor.page.goto(destination)
  await actor.page.getByRole("button", { name: "Sign in with passkey", exact: true }).click()
  await expect(actor.page.getByText(`Account: ${actor.name}`, { exact: true })).toBeVisible()
  expect((await account(actor)).account_id).toBe(actor.id)
}

async function logout(page: Page) {
  await page.bringToFront()
  await page.getByRole("button", { name: "Account", exact: true }).click()
  const completed = page.waitForResponse((response) => response.url().endsWith("/v1/auth/logout"))
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click()
  expect((await completed).status()).toBe(204)
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
}

async function register(name = "Browser MCP app", redirect = callbackURI) {
  const response = await native.post("/oauth/register", {
    data: {
      client_name: name,
      application_type: "native",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  })
  expect(response.status()).toBe(201)
  expect(response.headers()["cache-control"]).toContain("no-store")
  const result = await response.json()
  expect(result.token_endpoint_auth_method).toBe("none")
  expect(result).not.toHaveProperty("client_secret")
  expect(result.redirect_uris).toEqual([redirect])
  return { id: result.client_id, name, redirect } as Client
}

function authorization(client: Client, scope = offlineScope, redirect = client.redirect) {
  const verifier = remember(randomBytes(32).toString("base64url"))
  const state = randomBytes(24).toString("base64url")
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.id,
    redirect_uri: redirect,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
    scope,
    prompt: "consent",
  })
  return { params, verifier, state, scope, redirect }
}

async function begin(client = clientA, scope = offlineScope, redirect = client.redirect) {
  const request = authorization(client, scope, redirect)
  const response = await native.get(`/oauth/authorize?${request.params}`, { maxRedirects: 0 })
  expect(response.status()).toBe(302)
  expect(response.headers()["referrer-policy"]).toBe("no-referrer")
  const consent = new URL(response.headers().location, origin)
  expect(consent.origin).toBe(origin)
  expect(consent.pathname).toBe("/oauth/consent")
  expect([...consent.searchParams.keys()]).toEqual(["request"])
  const handle = consent.searchParams.get("request") as string
  expect(/^[A-Za-z0-9_-]{43}$/.test(handle)).toBe(true)
  return { client, handle, consent: consent.href, ...request } as Flow
}

async function counts(actor: Actor) {
  return JSON.parse(await command(helper, ["oauth-counts", actor.id])) as {
    grants: number
    tokens: number
  }
}

async function grants(actor: Actor) {
  const response = await actor.page.request.get("/v1/account/oauth/grants")
  expect(response.status()).toBe(200)
  expect(response.headers()["x-morsel-account-id"]).toBe(actor.id)
  expect(response.headers()["cache-control"]).toContain("no-store")
  const result: Grant[] = await response.json()
  expect(Array.isArray(result)).toBe(true)
  return result
}

async function showConsent(actor: Actor, flow: Flow) {
  await actor.page.bringToFront()
  await actor.page.goto(flow.consent)
  await expect(actor.page.getByRole("heading", { name: "Connect app", exact: true })).toBeVisible()
  await expect(actor.page.getByText(`Account: ${actor.name}`, { exact: true })).toBeVisible()
  await expect(actor.page.getByText(`Account ID: ${actor.id}`, { exact: true })).toBeVisible()
  const details = actor.page.locator("dl")
  for (const value of [
    flow.client.name,
    flow.client.id,
    new URL(flow.redirect).host,
    `${origin}/mcp`,
    flow.scope,
  ])
    await expect(details.getByText(value, { exact: true })).toBeVisible()
  await expect(actor.page.getByText(/The app name is unverified/)).toBeVisible()
  await expect(
    actor.page.getByRole("button", { name: "Approve access", exact: true }),
  ).toBeEnabled()
  await expect(actor.page.getByRole("button", { name: "Deny access", exact: true })).toBeEnabled()
}

async function invalidConsent(actor: Actor) {
  await expect(actor.page.getByText(invalidRequest, { exact: true })).toBeVisible()
  await expect(actor.page.getByRole("button", { name: "Approve access", exact: true })).toHaveCount(
    0,
  )
  await expect(actor.page.getByRole("button", { name: "Deny access", exact: true })).toHaveCount(0)
}

async function decide(actor: Actor, flow: Flow, approve: boolean, keyboard = false) {
  const completed = actor.page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/v1/account/oauth/requests/${flow.handle}` &&
      response.request().method() === "POST",
  )
  const button = actor.page.getByRole("button", {
    name: approve ? "Approve access" : "Deny access",
    exact: true,
  })
  if (keyboard) {
    await button.focus()
    await button.press("Enter")
  } else await button.click()
  const response = await completed
  expect(response.status()).toBe(200)
  expect(response.headers()["x-morsel-account-id"]).toBe(actor.id)
  expect(response.request().postDataJSON()).toEqual({ approve, account_id: actor.id })
  // A fast cross-origin navigation can discard Chromium's response body.
  // Read the code only from the native callback, as a real client does.
  await actor.page.waitForURL(
    (url) => url.origin === callbackOrigin && url.pathname === "/callback",
    { waitUntil: "domcontentloaded" },
  )
  const callback = new URL(actor.page.url())
  expect(`${callback.origin}${callback.pathname}`).toBe(flow.redirect)
  expect(callback.searchParams.get("state") === flow.state).toBe(true)
  expect(callback.searchParams.get("iss")).toBe(origin)
  if (approve) credential(callback.searchParams.get("code"), "moc_")
  else {
    expect(callback.searchParams.get("error")).toBe("access_denied")
    expect(callback.searchParams.has("code")).toBe(false)
  }
  await expect(actor.page).toHaveURL(callback.href)
  const received = callbacks.find((entry) => entry.url === callback.href)
  expect(!!received).toBe(true)
  expect(received?.referrer ?? "").toBe("")
  await actor.page.getByRole("link", { name: "Return to Morsel", exact: true }).click()
  await expect(actor.page.getByText(`Account: ${actor.name}`, { exact: true })).toBeVisible()
  return callback.searchParams.get("code") as string
}

async function tokenError(response: APIResponse, error = "invalid_grant", status = 400) {
  expect(response.status()).toBe(status)
  expect(response.headers()["cache-control"]).toContain("no-store")
  expect(response.headers().location).toBeUndefined()
  expect(await response.json()).toEqual({ error })
}

async function exchange(flow: Flow, code: string, changes: Record<string, string> = {}) {
  return native.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      client_id: flow.client.id,
      code,
      redirect_uri: flow.redirect,
      code_verifier: flow.verifier,
      resource: `${origin}/mcp`,
      ...changes,
    },
  })
}

async function tokens(response: APIResponse, scope = offlineScope) {
  expect(response.status()).toBe(200)
  expect(response.headers()["cache-control"]).toContain("no-store")
  const result = await response.json()
  expect(result.token_type.toLowerCase()).toBe("bearer")
  credential(result.access_token, "moa_")
  if (scope === offlineScope) credential(result.refresh_token, "mor_")
  else expect(result).not.toHaveProperty("refresh_token")
  expect(result.scope).toBe(scope)
  expect(result.expires_in).toBeGreaterThan(0)
  expect(result.expires_in).toBeLessThanOrEqual(600)
  return result as Tokens
}

async function refresh(flow: Flow, token: string) {
  return native.post("/oauth/token", {
    form: {
      grant_type: "refresh_token",
      client_id: flow.client.id,
      refresh_token: token,
      resource: `${origin}/mcp`,
    },
  })
}

async function issue(actor: Actor, client = clientA) {
  const before = new Set((await grants(actor)).map((grant) => grant.id))
  const flow = await begin(client)
  await showConsent(actor, flow)
  const code = await decide(actor, flow, true)
  const result = await tokens(await exchange(flow, code))
  const grant = (await grants(actor)).find((item) => !before.has(item.id))
  expect(!!grant && grant.client_id === client.id).toBe(true)
  return { flow, code, tokens: result, grant: grant as Grant } as Issued
}

async function mcp(token?: string, method = "tools/list", params?: unknown) {
  const response = await native.post("/mcp", {
    headers: {
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    data: { jsonrpc: "2.0", id: ++rpcID, method, ...(params ? { params } : {}) },
  })
  expect(response.headers()["cache-control"]).toContain("no-store")
  return response
}

async function tool(token: string, name: string, args: unknown) {
  const response = await mcp(token, "tools/call", { name, arguments: args })
  expect(response.status()).toBe(200)
  const result = await response.json()
  expect(result).not.toHaveProperty("error")
  return result.result as { isError?: boolean; structuredContent: Record<string, unknown> }
}

async function headers(actor: Actor) {
  const state = await account(actor)
  return { Origin: origin, "X-CSRF-Token": state.csrf_token as string }
}

async function decision(actor: Actor, flow: Flow, displayed = actor.id, approve = true) {
  return actor.page.request.post(`/v1/account/oauth/requests/${flow.handle}`, {
    headers: await headers(actor),
    data: { approve, account_id: displayed },
  })
}

async function invalidDecision(response: APIResponse | Response) {
  expect(response.status()).toBe(409)
  expect((await response.json()).code).toBe("oauth_request_invalid")
  expect(response.headers().location).toBeUndefined()
}

async function focus(actor: Actor) {
  await actor.page.evaluate(() => window.dispatchEvent(new Event("focus")))
}

async function accountPage(actor: Actor) {
  await actor.page.bringToFront()
  await actor.page.goto("/account")
  await expect(
    actor.page.getByRole("heading", { name: "Connected apps", exact: true }),
  ).toBeVisible()
}

function revokeButton(actor: Actor, grant: Grant) {
  return actor.page.getByRole("button", {
    name: `Revoke app ${grant.client_name} (${grant.id})`,
    exact: true,
  })
}

async function browserPrivacy() {
  const secrets = [...credentials]
  expect(secrets.length).toBeGreaterThan(0)
  expect(browserRequests.length).toBeGreaterThan(0)
  const publicFields = [...browserRequests, ...callbacks].map((entry) => {
    const url = new URL(entry.url)
    // A code is allowed only on the exact native callback. Never allow access
    // tokens, refresh tokens, or verifiers in a URL, including a Referrer.
    if (url.origin === callbackOrigin && url.pathname === "/callback") {
      const code = url.searchParams.get("code")
      if (code && /^moc_[A-Za-z0-9_-]{43}$/.test(code)) url.searchParams.delete("code")
    }
    return `${url.href} ${entry.referrer}`
  })
  for (const secret of secrets) {
    expect(publicFields.some((value) => value.includes(secret))).toBe(false)
    expect(browserMessages.some((value) => value.includes(secret))).toBe(false)
    await command(helper, ["assert-no-secret"], secret)
  }
  for (const actor of actors) {
    const state = JSON.stringify(await actor.context.storageState())
    expect(secrets.some((secret) => state.includes(secret))).toBe(false)
    for (const page of actor.context.pages()) {
      if (new URL(page.url()).origin !== origin) continue
      const leaked = await page.evaluate(async (values) => {
        const contains = (value: unknown) =>
          values.some((secret) => JSON.stringify(value)?.includes(secret))
        if (
          contains(location.href) ||
          contains(history.state) ||
          contains(localStorage) ||
          contains(sessionStorage) ||
          contains(document.body.textContent)
        )
          return true
        for (const entry of await indexedDB.databases()) {
          if (!entry.name) continue
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(entry.name as string)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(new Error("Cannot inspect browser database"))
          })
          try {
            for (const name of database.objectStoreNames) {
              const records = await new Promise<unknown[]>((resolve, reject) => {
                const request = database.transaction(name).objectStore(name).getAll()
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(new Error("Cannot inspect browser storage"))
              })
              if (contains(records)) return true
            }
          } finally {
            database.close()
          }
        }
        return false
      }, secrets)
      expect(leaked).toBe(false)
    }
  }
  const logs = await readFile(process.env.MORSEL_AUTH_TEST_SERVER_LOG as string, "utf8")
  expect(logs.length).toBeGreaterThan(0)
  expect(secrets.some((secret) => logs.includes(secret))).toBe(false)
  async function artifacts(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await artifacts(path)
      else {
        const bytes = await readFile(path)
        expect(secrets.some((secret) => bytes.includes(Buffer.from(secret)))).toBe(false)
      }
    }
  }
  await artifacts(process.env.MORSEL_AUTH_TEST_OUTPUT as string)
}

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ browser, playwright, baseURL }) => {
  origin = baseURL as string
  native = await playwright.request.newContext({ baseURL: origin })
  // This local callback records no logs and never exchanges codes automatically.
  callbackServer = createServer((request, response) => {
    callbacks.push({
      url: new URL(request.url as string, callbackOrigin).href,
      referrer: request.headers.referer ?? "",
    })
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    response.end(`<title>Connected</title><a href="${origin}/account">Return to Morsel</a>`)
  })
  await new Promise<void>((resolve, reject) => {
    callbackServer.once("error", reject)
    callbackServer.listen(0, "127.0.0.1", resolve)
  })
  const address = callbackServer.address()
  if (!address || typeof address === "string") throw new Error("Native callback did not start")
  callbackOrigin = `http://127.0.0.1:${address.port}`
  callbackURI = `${callbackOrigin}/callback`
  // The account phase has completed its sole-owner migration fixture. These
  // accounts and virtual authenticators are independent of that phase.
  alpha = await enrolled(browser, "Alpha")
  beta = await enrolled(browser, "Beta")
  expect(alpha.id).not.toBe(beta.id)
})

test.afterAll(async () => {
  try {
    if (alpha && beta) await browserPrivacy()
  } finally {
    await Promise.all(actors.map((actor) => actor.context.close()))
    await native?.dispose()
    if (callbackServer)
      await new Promise<void>((resolve, reject) => {
        callbackServer.close((error) => (error ? reject(error) : resolve()))
        callbackServer.closeAllConnections()
      })
  }
})

test("required real-backend OAuth discovery, registration, and PKCE", async () => {
  await test.step("discover only implemented public-native capabilities and the persistent scope", async () => {
    const challenge = await mcp()
    expect(challenge.status()).toBe(401)
    expect(challenge.headers()["www-authenticate"]).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    )
    expect(challenge.headers()["www-authenticate"]).toContain(`scope="${offlineScope}"`)
    const resource = await native.get("/.well-known/oauth-protected-resource/mcp")
    expect(resource.status()).toBe(200)
    expect(await resource.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["mcp:shares", "offline_access"],
      bearer_methods_supported: ["header"],
    })
    const discovery = await native.get("/.well-known/oauth-authorization-server")
    expect(discovery.status()).toBe(200)
    const metadata = await discovery.json()
    expect(metadata).toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    })
    expect(metadata).not.toHaveProperty("client_id_metadata_document_supported")
    const options = await native.fetch("/.well-known/oauth-authorization-server", {
      method: "OPTIONS",
      headers: { Origin: "https://native-metadata.invalid" },
    })
    expect(options.status()).toBe(204)
    expect(options.headers()["access-control-allow-origin"]).toBe("*")
  })

  await test.step("register two native public clients with identical unverified names", async () => {
    clientA = await register()
    clientB = await register()
    expect(clientA.name).toBe(clientB.name)
    expect(clientA.id).not.toBe(clientB.id)
    const invalid = await native.post("/oauth/register", {
      data: {
        client_name: "Invalid callback",
        token_endpoint_auth_method: "none",
        redirect_uris: [`${callbackURI}#fragment`],
      },
    })
    await tokenError(invalid, "invalid_redirect_uri")
    await tokenError(await native.get("/oauth/token"), "invalid_request", 405)
    await tokenError(
      await native.post("/oauth/token", { data: { grant_type: "authorization_code" } }),
      "invalid_request",
    )
  })

  await test.step("reject unsafe protocol fields before any callback redirect", async () => {
    const { params } = authorization(clientA)
    for (const [field, value, error] of [
      ["code_challenge_method", "plain", "invalid_request"],
      ["code_challenge", "short", "invalid_request"],
      ["redirect_uri", `${callbackURI}/foreign`, "invalid_request"],
      ["redirect_uri", "http://localhost:1/callback", "invalid_request"],
      ["resource", `${origin}/v1/account`, "invalid_request"],
      ["scope", "mcp:shares account:write", "invalid_scope"],
    ]) {
      const changed = new URLSearchParams(params)
      changed.set(field, value)
      const response = await native.get(`/oauth/authorize?${changed}`, { maxRedirects: 0 })
      await tokenError(response, error)
    }
    const duplicate = new URLSearchParams(params)
    duplicate.append("resource", `${origin}/mcp`)
    await tokenError(
      await native.get(`/oauth/authorize?${duplicate}`, { maxRedirects: 0 }),
      "invalid_request",
    )
    const missing = new URLSearchParams(params)
    missing.delete("resource")
    await tokenError(
      await native.get(`/oauth/authorize?${missing}`, { maxRedirects: 0 }),
      "invalid_request",
    )
    // The precise IP-literal loopback port exception is accepted. GET still
    // creates only a bounded request, never a grant or token.
    const before = await counts(alpha)
    const changedPort = new URL(callbackURI)
    changedPort.port = changedPort.port === "65535" ? "65534" : String(Number(changedPort.port) + 1)
    await begin(clientA, offlineScope, changedPort.href)
    expect(await counts(alpha)).toEqual(before)
    expect(callbacks).toHaveLength(0)
  })
})

test("required real-backend OAuth passkey consent, continuation, and no GET issuance", async () => {
  await test.step("reload and passkey login preserve only the exact consent continuation", async () => {
    await logout(alpha.page)
    const before = await counts(alpha)
    const flow = await begin()
    await alpha.page.goto(flow.consent)
    const next = `/oauth/consent?request=${flow.handle}`
    await expect(alpha.page).toHaveURL(`${origin}/login?next=${encodeURIComponent(next)}`)
    await alpha.page.reload()
    expect(await counts(alpha)).toEqual(before)
    await alpha.page.bringToFront()
    await alpha.page.getByRole("button", { name: "Sign in with passkey", exact: true }).click()
    await expect(alpha.page).toHaveURL(flow.consent)
    await showConsent(alpha, flow)
    await expect(
      alpha.page.getByRole("heading", { name: "Connect app", exact: true }),
    ).toBeFocused()
    await alpha.page.reload()
    await expect(
      alpha.page.getByRole("button", { name: "Approve access", exact: true }),
    ).toBeEnabled()
    expect(await counts(alpha)).toEqual(before)
    const code = await decide(alpha, flow, true, true)
    const after = await counts(alpha)
    expect(after.grants).toBe(before.grants + 1)
    expect(after.tokens).toBeGreaterThan(before.tokens)
    const result = await tokens(await exchange(flow, code))
    const listed = await mcp(result.access_token)
    expect(listed.status()).toBe(200)
    expect(
      (await listed.json()).result.tools.map((item: { name: string }) => item.name).sort(),
    ).toEqual(["create_share", "get_share", "revoke_share"])
    await invalidDecision(await decision(alpha, flow))
  })

  await test.step("approval verifies a stale passkey and narrow scope does not issue refresh", async () => {
    await command(helper, ["expire-verification", alpha.id])
    const flow = await begin(clientA, "mcp:shares")
    await showConsent(alpha, flow)
    let prompts = 0
    let decisions = 0
    const observe = (request: import("@playwright/test").Request) => {
      if (request.url().endsWith("/v1/auth/verify/begin")) prompts += 1
      if (
        request.url().endsWith(`/v1/account/oauth/requests/${flow.handle}`) &&
        request.method() === "POST"
      )
        decisions += 1
    }
    alpha.page.on("request", observe)
    try {
      const code = await test.step("fresh virtual passkey completes one explicit approval", () =>
        decide(alpha, flow, true))
      const result =
        await test.step("narrow code exchanges without a refresh credential", async () =>
          tokens(await exchange(flow, code), "mcp:shares"))
      await test.step("narrow access remains valid and no mutation is retried", async () => {
        expect((await mcp(result.access_token)).status()).toBe(200)
        expect(prompts).toBe(1)
        expect(decisions).toBe(1)
      })
    } finally {
      alpha.page.off("request", observe)
    }
  })
})

test("required real-backend OAuth exchange, expiry, refresh rotation, and replay", async () => {
  await test.step("bind the one-use code to client, verifier, redirect, and resource", async () => {
    const flow = await begin()
    await showConsent(alpha, flow)
    const code = await decide(alpha, flow, true)
    const wrongVerifier = remember(randomBytes(32).toString("base64url"))
    const mismatches: Record<string, string>[] = [
      { code_verifier: wrongVerifier },
      { client_id: clientB.id },
      { redirect_uri: `${callbackURI}/foreign` },
    ]
    for (const changes of mismatches) await tokenError(await exchange(flow, code, changes))
    await tokenError(
      await exchange(flow, code, { resource: `${origin}/v1/shares` }),
      "invalid_request",
    )
    const result = await tokens(await exchange(flow, code))
    expect((await mcp(result.access_token)).status()).toBe(200)
    await tokenError(await exchange(flow, code))
    expect((await mcp(result.access_token)).status()).toBe(401)
  })

  await test.step("expire access without a sleep, rotate refresh, and revoke on detected reuse", async () => {
    const issued = await issue(alpha)
    await command(helper, ["expire-oauth-access"], issued.tokens.access_token)
    expect((await mcp(issued.tokens.access_token)).status()).toBe(401)
    const rotated = await tokens(await refresh(issued.flow, issued.tokens.refresh_token as string))
    expect(rotated.access_token === issued.tokens.access_token).toBe(false)
    expect(rotated.refresh_token === issued.tokens.refresh_token).toBe(false)
    expect((await mcp(rotated.access_token)).status()).toBe(200)
    await tokenError(await refresh(issued.flow, issued.tokens.refresh_token as string))
    expect((await mcp(rotated.access_token)).status()).toBe(401)
    await tokenError(await refresh(issued.flow, rotated.refresh_token as string))
  })
})

test("required real-backend OAuth denial, errors, and displayed-account binding", async () => {
  await test.step("deny without fresh verification and issue no credential", async () => {
    await command(helper, ["expire-verification", alpha.id])
    const before = await counts(alpha)
    const flow = await begin()
    await showConsent(alpha, flow)
    let prompts = 0
    const observe = (request: import("@playwright/test").Request) => {
      if (request.url().endsWith("/v1/auth/verify/begin")) prompts += 1
    }
    alpha.page.on("request", observe)
    try {
      await decide(alpha, flow, false, true)
      expect(prompts).toBe(0)
      expect(await counts(alpha)).toEqual(before)
      await invalidDecision(await decision(alpha, flow, alpha.id, false))
    } finally {
      alpha.page.off("request", observe)
    }
  })

  await test.step("invalid and expired handles stop safely without an app callback", async () => {
    const before = await counts(alpha)
    const delivered = callbacks.length
    const flow = await begin()
    await command(helper, ["expire-oauth-request"], flow.handle)
    await alpha.page.goto(flow.consent)
    await invalidConsent(alpha)
    await invalidDecision(await decision(alpha, flow, alpha.id, false))
    await alpha.page.goto(`/oauth/consent?request=${randomBytes(32).toString("base64url")}`)
    await invalidConsent(alpha)
    expect(callbacks.length).toBe(delivered)
    expect(await counts(alpha)).toEqual(before)
  })

  await test.step("a failed consent read retries only GET and displayed-account mismatch is rejected", async () => {
    const before = await counts(alpha)
    const flow = await begin()
    let reads = 0
    const path = `**/v1/account/oauth/requests/${flow.handle}`
    let decisions = 0
    await alpha.page.route(path, async (route) => {
      if (route.request().method() === "GET" && reads++ === 0) await route.abort("failed")
      else if (route.request().method() === "POST") {
        decisions += 1
        // Keep the displayed Alpha page but send a mismatched displayed ID.
        // The real backend must reject it and the UI must stop the flow.
        await route.continue({ postData: JSON.stringify({ approve: false, account_id: beta.id }) })
      } else await route.continue()
    })
    try {
      await alpha.page.goto(flow.consent)
      await alpha.page.getByRole("button", { name: "Retry request", exact: true }).click()
      await expect(
        alpha.page.getByRole("button", { name: "Approve access", exact: true }),
      ).toBeEnabled()
      expect(reads).toBe(2)
      const completion = alpha.page.waitForResponse(
        (response) =>
          response.url().endsWith(`/v1/account/oauth/requests/${flow.handle}`) &&
          response.request().method() === "POST",
      )
      await alpha.page.getByRole("button", { name: "Deny access", exact: true }).click()
      await invalidDecision(await completion)
      await invalidConsent(alpha)
      expect(decisions).toBe(1)
      expect(await counts(alpha)).toEqual(before)
    } finally {
      await alpha.page.unroute(path)
    }
  })
})

test("required real-backend OAuth account switch, session replacement, and cross-tab logout", async () => {
  await test.step("a request displayed for Alpha cannot be approved by Beta", async () => {
    const flow = await begin()
    await showConsent(alpha, flow)
    const beforeA = await counts(alpha)
    const beforeB = await counts(beta)
    const cookies = await alpha.context.cookies()
    try {
      await alpha.context.addCookies(await beta.context.cookies())
      await focus(alpha)
      await expect(alpha.page.getByText("Account: Beta", { exact: true })).toBeVisible()
      await invalidConsent(alpha)
      await invalidDecision(await decision(alpha, flow, alpha.id, false))
      expect(await counts(alpha)).toEqual(beforeA)
      expect(await counts(beta)).toEqual(beforeB)
    } finally {
      await alpha.context.addCookies(cookies)
      await accountPage(alpha)
    }
  })

  await test.step("a different session for the same displayed account invalidates the bound request", async () => {
    const flow = await begin()
    await showConsent(alpha, flow)
    const boundCookies = await alpha.context.cookies()
    const before = await counts(alpha)
    await alpha.context.clearCookies()
    await login(alpha)
    const replacementCookies = await alpha.context.cookies()
    await alpha.context.addCookies(boundCookies)
    await showConsent(alpha, flow)
    await alpha.context.addCookies(replacementCookies)
    await focus(alpha)
    await expect(alpha.page.getByText("Account: Alpha", { exact: true })).toBeVisible()
    const completed = alpha.page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/account/oauth/requests/${flow.handle}`) &&
        response.request().method() === "POST",
    )
    await alpha.page.getByRole("button", { name: "Approve access", exact: true }).click()
    await invalidDecision(await completed)
    await invalidConsent(alpha)
    expect(await counts(alpha)).toEqual(before)
  })

  await test.step("real cross-tab logout cancels pending consent but preserves issued grants", async () => {
    const issued = await issue(alpha)
    const flow = await begin()
    await showConsent(alpha, flow)
    const observer = await alpha.context.newPage()
    try {
      await observer.goto("/account")
      await logout(observer)
      await expect(
        alpha.page.getByRole("button", { name: "Sign in with passkey", exact: true }),
      ).toBeVisible()
      await expect(
        alpha.page.getByRole("button", { name: "Approve access", exact: true }),
      ).toHaveCount(0)
      expect((await mcp(issued.tokens.access_token)).status()).toBe(200)
      await login(alpha, flow.consent)
      await invalidConsent(alpha)
      await expect(observer.getByText("Account: Alpha", { exact: true })).toBeVisible()
    } finally {
      await observer.close()
    }
  })
})

test("required real-backend OAuth delayed consent and connected-app response races", async () => {
  await test.step("a delayed consent read cannot restore the previous account", async () => {
    const flow = await begin()
    const cookies = await alpha.context.cookies()
    const received = deferred()
    const release = deferred()
    const settled = deferred()
    let held = false
    const path = `**/v1/account/oauth/requests/${flow.handle}`
    await alpha.page.route(path, async (route) => {
      if (held || route.request().method() !== "GET") return route.continue()
      held = true
      try {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        expect(response.headers()["x-morsel-account-id"]).toBe(alpha.id)
        received.resolve()
        await release.promise
        await route.fulfill({ response })
      } finally {
        settled.resolve()
      }
    })
    try {
      await alpha.page.goto(flow.consent)
      await received.promise
      await alpha.context.addCookies(await beta.context.cookies())
      await focus(alpha)
      await expect(alpha.page.getByText("Account: Beta", { exact: true })).toBeVisible()
      release.resolve()
      await settled.promise
      await invalidConsent(alpha)
      await expect(alpha.page.locator("dl")).toHaveCount(0)
    } finally {
      release.resolve()
      await alpha.page.unroute(path)
      await alpha.context.addCookies(cookies)
      await accountPage(alpha)
    }
  })

  let delayed: Issued
  await test.step("a completed Alpha approval cannot redirect the browser after it switches to Beta", async () => {
    const before = new Set((await grants(alpha)).map((grant) => grant.id))
    const flow = await begin()
    await showConsent(alpha, flow)
    const cookies = await alpha.context.cookies()
    const received = deferred()
    const release = deferred()
    const settled = deferred()
    const path = `**/v1/account/oauth/requests/${flow.handle}`
    let code = ""
    let submissions = 0
    const delivered = callbacks.length
    await alpha.page.route(path, async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      submissions += 1
      try {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        code = credential(
          new URL((await response.json()).redirect_url).searchParams.get("code"),
          "moc_",
        )
        received.resolve()
        await release.promise
        await route.fulfill({ response })
      } finally {
        settled.resolve()
      }
    })
    try {
      await alpha.page.getByRole("button", { name: "Approve access", exact: true }).click()
      await received.promise
      await alpha.context.addCookies(await beta.context.cookies())
      await focus(alpha)
      await expect(alpha.page.getByText("Account: Beta", { exact: true })).toBeVisible()
      release.resolve()
      await settled.promise
      await invalidConsent(alpha)
      expect(callbacks.length).toBe(delivered)
      expect(submissions).toBe(1)
    } finally {
      release.resolve()
      await alpha.page.unroute(path)
      await alpha.context.addCookies(cookies)
      await accountPage(alpha)
    }
    const result = await tokens(await exchange(flow, code))
    const grant = (await grants(alpha)).find((item) => !before.has(item.id)) as Grant
    expect(!!grant).toBe(true)
    delayed = { flow, code, tokens: result, grant }
    const created = await tool(result.access_token, "create_share", {
      content: "# Delayed Alpha approval",
    })
    expect(created.isError ?? false).toBe(false)
    expect(
      (await alpha.page.request.get(`/v1/account/shares/${created.structuredContent.id}`)).status(),
    ).toBe(200)
    expect(
      (await beta.page.request.get(`/v1/account/shares/${created.structuredContent.id}`)).status(),
    ).toBe(404)
  })

  await test.step("a delayed connected-app list cannot display another account's grants", async () => {
    const betaGrant = await issue(beta, clientB)
    const cookies = await alpha.context.cookies()
    const received = deferred()
    const release = deferred()
    const settled = deferred()
    let held = false
    const path = "**/v1/account/oauth/grants"
    await alpha.page.route(path, async (route) => {
      if (held || route.request().method() !== "GET") return route.continue()
      held = true
      try {
        const response = await route.fetch()
        expect(response.headers()["x-morsel-account-id"]).toBe(alpha.id)
        received.resolve()
        await release.promise
        await route.fulfill({ response })
      } finally {
        settled.resolve()
      }
    })
    try {
      await alpha.page.goto("/account")
      await received.promise
      await alpha.context.addCookies(await beta.context.cookies())
      await focus(alpha)
      await expect(alpha.page.getByText("Account: Beta", { exact: true })).toBeVisible()
      release.resolve()
      await settled.promise
      await expect(revokeButton(alpha, delayed.grant)).toHaveCount(0)
      await expect(revokeButton(alpha, betaGrant.grant)).toBeVisible()
    } finally {
      release.resolve()
      await alpha.page.unroute(path)
      await alpha.context.addCookies(cookies)
      await accountPage(alpha)
    }
  })

  await test.step("a delayed revoke completion cannot report success in the replacement account", async () => {
    await accountPage(alpha)
    await revokeButton(alpha, delayed.grant).click()
    const cookies = await alpha.context.cookies()
    const received = deferred()
    const release = deferred()
    const settled = deferred()
    const path = `**/v1/account/oauth/grants/${delayed.grant.id}`
    await alpha.page.route(path, async (route) => {
      try {
        const response = await route.fetch()
        expect(response.status()).toBe(204)
        received.resolve()
        await release.promise
        await route.fulfill({ response })
      } finally {
        settled.resolve()
      }
    })
    try {
      await alpha.page.getByRole("button", { name: "Confirm revoke app", exact: true }).click()
      await received.promise
      await alpha.context.addCookies(await beta.context.cookies())
      await focus(alpha)
      await expect(alpha.page.getByText("Account: Beta", { exact: true })).toBeVisible()
      release.resolve()
      await settled.promise
      await expect(
        alpha.page.getByText("App access revoked. Existing shares are unchanged.", { exact: true }),
      ).toHaveCount(0)
      await expect(
        alpha.page.getByRole("heading", { name: "Revoke app access?", exact: true }),
      ).toHaveCount(0)
      expect((await mcp(delayed.tokens.access_token)).status()).toBe(401)
    } finally {
      release.resolve()
      await alpha.page.unroute(path)
      await alpha.context.addCookies(cookies)
      await accountPage(alpha)
    }
  })
})

test("required real-backend OAuth account-owned connected-app revocation", async () => {
  const owned = await issue(alpha)
  const retained = await issue(alpha)
  const foreign = await issue(beta, clientB)
  const share = await tool(owned.tokens.access_token, "create_share", {
    content: "# Revoke preserves shares",
  })
  expect(share.isError ?? false).toBe(false)

  await test.step("identical names retain client and grant identities and foreign revoke is indistinguishable", async () => {
    const listA = await grants(alpha)
    const listB = await grants(beta)
    expect(listA.some((item) => item.id === foreign.grant.id)).toBe(false)
    expect(listB.some((item) => item.id === owned.grant.id)).toBe(false)
    for (const id of [foreign.grant.id, "ffffffff-ffff-4fff-8fff-ffffffffffff"]) {
      const response = await alpha.page.request.delete(`/v1/account/oauth/grants/${id}`, {
        headers: await headers(alpha),
      })
      expect(response.status()).toBe(404)
      expect((await response.json()).code).toBe("not_found")
    }
    expect((await mcp(foreign.tokens.access_token)).status()).toBe(200)
    await accountPage(alpha)
    await expect(revokeButton(alpha, owned.grant)).toBeVisible()
    await expect(revokeButton(alpha, retained.grant)).toBeVisible()
    await expect(revokeButton(alpha, foreign.grant)).toHaveCount(0)
    const row = alpha.page.locator("li").filter({ has: revokeButton(alpha, owned.grant) })
    await expect(row.getByText(`Client ID: ${clientA.id}`, { exact: true })).toBeVisible()
    await expect(row.getByText(`Connection ID: ${owned.grant.id}`, { exact: true })).toBeVisible()
  })

  await test.step("connected-app read failure retries GET and cancel restores focus without revocation", async () => {
    let held = false
    const path = "**/v1/account/oauth/grants"
    await alpha.page.route(path, async (route) => {
      if (!held && route.request().method() === "GET") {
        held = true
        await route.abort("failed")
      } else await route.continue()
    })
    try {
      await alpha.page.reload()
      await alpha.page.getByRole("button", { name: "Retry connected apps", exact: true }).click()
      await expect(revokeButton(alpha, owned.grant)).toBeEnabled()
    } finally {
      await alpha.page.unroute(path)
    }
    await revokeButton(alpha, owned.grant).click()
    await expect(
      alpha.page.getByRole("heading", { name: "Revoke app access?", exact: true }),
    ).toBeVisible()
    await expect(alpha.page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused()
    await alpha.page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(revokeButton(alpha, owned.grant)).toBeFocused()
    expect((await mcp(owned.tokens.access_token)).status()).toBe(200)
  })

  await test.step("fresh passkey revocation affects only its grant family and no existing share", async () => {
    await command(helper, ["expire-verification", alpha.id])
    const state = await headers(alpha)
    const missingCSRF = await alpha.page.request.delete(
      `/v1/account/oauth/grants/${owned.grant.id}`,
      {
        headers: { Origin: origin },
      },
    )
    expect(missingCSRF.status()).toBe(403)
    const wrongOrigin = await alpha.page.request.delete(
      `/v1/account/oauth/grants/${owned.grant.id}`,
      {
        headers: { ...state, Origin: "https://wrong-origin.invalid" },
      },
    )
    expect(wrongOrigin.status()).toBe(403)
    const stale = await alpha.page.request.delete(`/v1/account/oauth/grants/${owned.grant.id}`, {
      headers: state,
    })
    expect(stale.status()).toBe(403)
    expect((await stale.json()).code).toBe("verification_required")
    await revokeButton(alpha, owned.grant).click()
    const verified = alpha.page.waitForResponse((response) =>
      response.url().endsWith("/v1/auth/verify/finish"),
    )
    const completed = alpha.page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/account/oauth/grants/${owned.grant.id}`) &&
        response.request().method() === "DELETE",
    )
    await alpha.page.getByRole("button", { name: "Confirm revoke app", exact: true }).click()
    expect((await verified).status()).toBe(200)
    const response = await completed
    expect(response.status()).toBe(204)
    expect(response.headers()["x-morsel-account-id"]).toBe(alpha.id)
    await expect(
      alpha.page.getByText("App access revoked. Existing shares are unchanged.", { exact: true }),
    ).toBeVisible()
    await expect(
      alpha.page.getByRole("heading", { name: "Connected apps", exact: true }),
    ).toBeFocused()
    await expect(revokeButton(alpha, owned.grant)).toHaveCount(0)
    await expect(revokeButton(alpha, retained.grant)).toBeVisible()
    expect((await mcp(owned.tokens.access_token)).status()).toBe(401)
    await tokenError(await refresh(owned.flow, owned.tokens.refresh_token as string))
    expect((await mcp(retained.tokens.access_token)).status()).toBe(200)
    expect((await mcp(foreign.tokens.access_token)).status()).toBe(200)
    const detail = await alpha.page.request.get(`/v1/account/shares/${share.structuredContent.id}`)
    expect(detail.status()).toBe(200)
    expect((await detail.json()).content).toBe("# Revoke preserves shares")
    const revoked = await native.post("/oauth/revoke", {
      form: {
        client_id: retained.flow.client.id,
        token: retained.tokens.refresh_token as string,
        token_type_hint: "refresh_token",
      },
    })
    expect(revoked.status()).toBe(200)
    expect((await mcp(retained.tokens.access_token)).status()).toBe(401)
    // Revocation does not reveal whether an unknown credential existed.
    expect(
      (
        await native.post("/oauth/revoke", {
          form: {
            client_id: retained.flow.client.id,
            token: `mor_${randomBytes(32).toString("base64url")}`,
          },
        })
      ).status(),
    ).toBe(200)
  })
})

test("required real-backend OAuth recovery, credential separation, and legacy keys", async ({
  browser,
}) => {
  const issuedA = await issue(alpha)
  const issuedB = await issue(beta, clientB)
  let key = ""
  let unredeemed: Flow
  let unredeemedCode = ""

  await test.step("OAuth credentials authorize only MCP while legacy keys retain REST and MCP", async () => {
    await alpha.page.goto("/manage/api-keys")
    await alpha.page.getByLabel("API key name", { exact: true }).fill("OAuth legacy compatibility")
    const completed = alpha.page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/api-keys") && response.request().method() === "POST",
    )
    await alpha.page.getByRole("button", { name: "Create API key", exact: true }).click()
    key = remember((await (await completed).json()).key)
    await alpha.page.getByRole("button", { name: "Dismiss API key", exact: true }).click()
    expect((await mcp(key)).status()).toBe(200)
    const legacy = await native.post("/v1/shares", {
      headers: { Authorization: `Bearer ${key}` },
      data: { content: "# Legacy REST remains unchanged" },
    })
    expect(legacy.status()).toBe(201)
    const oauthREST = await native.post("/v1/shares", {
      headers: { Authorization: `Bearer ${issuedA.tokens.access_token}` },
      data: { content: "Must not be created" },
    })
    expect(oauthREST.status()).toBe(401)
    for (const token of [
      key,
      issuedA.tokens.access_token,
      issuedA.tokens.refresh_token as string,
    ]) {
      expect(
        (
          await native.get("/v1/account/oauth/grants", {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status(),
      ).toBe(401)
      expect(
        (
          await native.get("/v1/passkeys", { headers: { Authorization: `Bearer ${token}` } })
        ).status(),
      ).toBe(401)
    }
    expect((await mcp(issuedA.tokens.refresh_token)).status()).toBe(401)
    unredeemed = await begin()
    await showConsent(alpha, unredeemed)
    unredeemedCode = await decide(alpha, unredeemed, true)
    expect((await mcp(unredeemedCode)).status()).toBe(401)
    const cookieOnly = await alpha.page.request.post("/mcp", {
      headers: {
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      data: { jsonrpc: "2.0", id: ++rpcID, method: "tools/list" },
    })
    expect(cookieOnly.status()).toBe(401)
  })

  await test.step("recovery wins a pending approval race and invalidates codes and token families", async () => {
    const old = alpha
    const pending = await begin()
    await showConsent(old, pending)
    const before = await counts(old)
    const received = deferred()
    const release = deferred()
    const path = `**/v1/account/oauth/requests/${pending.handle}`
    const delivered = callbacks.length
    await old.page.route(path, async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      received.resolve()
      await release.promise
      await route.continue()
    })
    try {
      await old.page.getByRole("button", { name: "Approve access", exact: true }).click()
      await received.promise
      const recovery = remember(
        await command(accountCLI, ["-kind", "recover", "-account-id", old.id]),
      )
      const context = await browser.newContext({ baseURL: origin })
      observe(context)
      const page = await context.newPage()
      const replacement: Actor = {
        context,
        page,
        cdp: await virtualPasskey(context, page),
        id: old.id,
        name: old.name,
      }
      actors.push(replacement)
      await page.goto(
        `/recover?next=${encodeURIComponent(`/oauth/consent?request=${pending.handle}`)}`,
      )
      await page.getByLabel("Recovery token", { exact: true }).fill(recovery)
      await page
        .getByLabel("Replacement passkey name", { exact: true })
        .fill("Recovered Alpha OAuth passkey")
      await page.bringToFront()
      await page.getByRole("button", { name: "Recover account", exact: true }).click()
      await invalidConsent(replacement)
      expect((await account(replacement)).account_id).toBe(old.id)
      expect((await account(replacement)).display_name).toBe("Alpha")
      const completion = old.page.waitForResponse(
        (response) =>
          response.url().endsWith(`/v1/account/oauth/requests/${pending.handle}`) &&
          response.request().method() === "POST",
      )
      release.resolve()
      expect((await completion).status()).toBe(401)
      await expect(
        old.page.getByRole("button", { name: "Sign in with passkey", exact: true }),
      ).toBeVisible()
      expect((await account(old)).authenticated).toBe(false)
      expect(await counts(old)).toEqual(before)
      expect(callbacks.length).toBe(delivered)
      alpha = replacement
    } finally {
      release.resolve()
      await old.page.unroute(path)
    }
    expect((await mcp(issuedA.tokens.access_token)).status()).toBe(401)
    await tokenError(await refresh(issuedA.flow, issuedA.tokens.refresh_token as string))
    await tokenError(await exchange(unredeemed, unredeemedCode))
    expect((await mcp(issuedB.tokens.access_token)).status()).toBe(200)
    const legacy = await native.post("/v1/shares", {
      headers: { Authorization: `Bearer ${key}` },
      data: { content: "# Legacy key survives OAuth recovery" },
    })
    expect(legacy.status()).toBe(201)
    expect((await mcp(key)).status()).toBe(200)
  })

  await test.step("replacement passkey requires new explicit consent and restores only its own access", async () => {
    await accountPage(alpha)
    await logout(alpha.page)
    const flow = await begin()
    await login(alpha, flow.consent)
    await showConsent(alpha, flow)
    const before = await counts(alpha)
    await alpha.page.reload()
    await expect(
      alpha.page.getByRole("button", { name: "Approve access", exact: true }),
    ).toBeEnabled()
    expect(await counts(alpha)).toEqual(before)
    const code = await decide(alpha, flow, true)
    const result = await tokens(await exchange(flow, code))
    expect((await mcp(result.access_token)).status()).toBe(200)
    expect((await mcp(issuedB.tokens.access_token)).status()).toBe(200)
  })
})
