// Local-only integration gate. Pi is an explicitly selected external tool, not
// a project dependency. Never run this script against a non-disposable database.
// Usage: node scripts/test-mcp-oauth-pi.mjs --pi-directory /absolute/pi/package
//        [--report-directory /new/evidence/directory]
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), "..")
const scope = "mcp:shares offline_access"
const tools = ["create_share", "get_share", "revoke_share"]
const driver =
  "installed Pi McpServerConnection/createDefaultTransport + signInMcpServer + McpOAuthCredentialStore/FileAuthStorageBackend"
const checkpoints = [
  "imports",
  "initial-challenge",
  "sign-in",
  "connect",
  "create",
  "read",
  "revoke",
  "persistence",
  "close",
]
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

// Assertion diagnostics must not include actual values, URLs, response bodies,
// tokens, or Playwright call logs. Only fixed phase names reach the terminal.
function check(value) {
  if (!value) throw new Error("Integration check failed")
}

function importFile(directory, path) {
  return import(pathToFileURL(join(directory, path)).href)
}

async function worker() {
  check(typeof process.send === "function")
  const config = await new Promise((done) => process.once("message", done))
  const { directory, piDirectory, origin, stage } = config
  check(isAbsolute(directory) && process.cwd() === join(directory, "workspace"))
  const profile = join(directory, "pi")
  check(process.env.PI_CODING_AGENT_DIR === profile)
  const serverUrl = `${origin}/mcp`
  const requests = []
  const secrets = new Set()
  const shareSecrets = new Set()
  const pending = new Map()
  let serial = 0
  const abort = new AbortController()
  process.on("message", (message) => {
    if (message.type === "cancel") abort.abort()
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id)
      if (message.ok) request.resolve()
      else request.reject(new Error("Browser check failed"))
    }
  })
  const send = (message) => process.send(message)
  const checkpoint = (name) => send({ type: "checkpoint", name })
  function remember(value) {
    if (typeof value === "string" && value.length >= 32) secrets.add(value)
  }
  function rememberState(state) {
    remember(state?.tokens?.access_token)
    remember(state?.tokens?.refresh_token)
    remember(state?.codeVerifier)
  }
  function inspect(id, count, revoked = false) {
    return new Promise((resolve, reject) => {
      const request = ++serial
      pending.set(request, { resolve, reject })
      send({ type: "inspect", id: request, share: id, count, revoked })
    })
  }

  // Observe the installed client's real requests without replacing its OAuth
  // implementation or recording protocol payloads. No external fetch is allowed.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    check(url.origin === origin)
    const headers = new Headers(init.headers)
    check(!headers.has("cookie"))
    check(!url.searchParams.has("access_token") && !url.searchParams.has("code_verifier"))
    const body = init.body instanceof URLSearchParams ? init.body : undefined
    let method
    let tool
    if (url.pathname === "/oauth/register") {
      const registration = JSON.parse(init.body)
      check(registration.client_name === "pi")
      check(registration.application_type === "native")
      check(registration.token_endpoint_auth_method === "none")
      check(
        JSON.stringify(registration.grant_types) ===
          JSON.stringify(["authorization_code", "refresh_token"]),
      )
      check(JSON.stringify(registration.response_types) === JSON.stringify(["code"]))
      check(registration.scope === scope && registration.redirect_uris.length === 1)
      const redirect = new URL(registration.redirect_uris[0])
      check(
        redirect.protocol === "http:" &&
          redirect.hostname === "127.0.0.1" &&
          redirect.port &&
          redirect.pathname === "/callback" &&
          !redirect.search &&
          !redirect.hash,
      )
      check(!("client_secret" in registration))
    }
    if (url.pathname === "/oauth/token") {
      check(body?.get("resource") === serverUrl && body.get("client_id"))
      check(!body.has("client_secret") && !headers.has("authorization"))
      if (body.get("grant_type") === "authorization_code") {
        remember(body.get("code"))
        remember(body.get("code_verifier"))
        check(
          createHash("sha256").update(body.get("code_verifier")).digest("base64url") ===
            authorization?.searchParams.get("code_challenge"),
        )
        check(body.get("redirect_uri") === authorization?.searchParams.get("redirect_uri"))
      } else {
        check(body.get("grant_type") === "refresh_token" && !body.has("scope"))
        remember(body.get("refresh_token"))
      }
    }
    if (url.pathname === "/mcp" && typeof init.body === "string") {
      const rpc = JSON.parse(init.body)
      method = rpc.method
      tool = rpc.params?.name
    }
    const response = await originalFetch(input, init)
    if (url.pathname === "/oauth/token" && response.ok) {
      const tokens = await response.clone().json()
      remember(tokens.access_token)
      remember(tokens.refresh_token)
    }
    requests.push({
      path: url.pathname,
      status: response.status,
      grant: body?.get("grant_type"),
      method,
      tool,
    })
    return response
  }

  let authorization
  let connection
  try {
    checkpoint("imports")
    const {
      McpServerConnection,
      createDefaultTransport,
      McpOAuthCredentialStore,
      signInMcpServer,
    } = await importFile(piDirectory, "dist/extensions/mcp/runtime.js")
    const { FileAuthStorageBackend } = await importFile(piDirectory, "dist/core/auth-storage.js")
    const credentials = new McpOAuthCredentialStore(
      new FileAuthStorageBackend(join(profile, "mcp-auth.json")),
      profile,
    )
    const store = credentials.forServer("morsel-pi-fixture", serverUrl)
    const before = await store.load()
    rememberState(before)
    connection = new McpServerConnection({
      entry: {
        name: "morsel-pi-fixture",
        config: { url: serverUrl, timeout: 15 },
        source: script,
        scope: "extension",
      },
      cwd: process.cwd(),
      createTransport: createDefaultTransport,
      credentials,
      onTools() {},
    })
    const signIn = async () => {
      await signInMcpServer({
        serverUrl,
        store,
        settings: connection.oauthSettings(),
        challenge: connection.challenge,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]),
        prompt: {
          showAuthorizationUrl(url) {
            authorization = new URL(url)
            check(authorization.origin === origin && authorization.pathname === "/oauth/authorize")
            check(authorization.searchParams.get("scope") === scope)
            check(authorization.searchParams.get("resource") === serverUrl)
            check(authorization.searchParams.get("code_challenge_method") === "S256")
            check(authorization.searchParams.get("prompt") === "consent")
            void Promise.resolve(store.load())
              .then((state) => {
                rememberState(state)
                send({ type: "authorize", url: authorization.href, secrets: [...secrets] })
              })
              .catch(() => abort.abort())
          },
          // The actual loopback listener wins. Never open a terminal prompt or
          // use a pasted callback as a substitute for the browser redirect.
          promptForRedirectUrl(signal) {
            return new Promise((_, reject) => {
              if (signal.aborted) reject(new Error("No interactive prompt"))
              else
                signal.addEventListener("abort", () => reject(new Error("No interactive prompt")), {
                  once: true,
                })
            })
          },
        },
      })
    }
    const expectNeedsAuth = async () => {
      let refused = false
      try {
        await connection.getClient()
      } catch {
        refused = true
      }
      check(refused && connection.state === "needs-auth")
      check(connection.challenge?.scope === scope)
      check(
        connection.challenge.resourceMetadataUrl.href ===
          `${origin}/.well-known/oauth-protected-resource/mcp`,
      )
    }
    const loginStages = [
      "login",
      "reuse",
      "authorize-revocation",
      "reauthorize-revocation",
      "reauthorize-recovery",
    ]
    if (stage === "login") {
      check(before === undefined)
      checkpoint("initial-challenge")
      await expectNeedsAuth()
    } else check(before?.clientInformation)

    if (stage === "reuse" || stage === "denial") {
      check(before.tokens?.refresh_token)
      // Test-only removal of credentials forces explicit consent while keeping
      // the installed client's persisted DCR registration and discovery state.
      const next = { ...before }
      delete next.tokens
      delete next.tokensExpireAt
      await store.save(next)
    }
    if (["revoked", "recovered"].includes(stage)) {
      check(before.tokens?.refresh_token)
      await expectNeedsAuth()
      check(!(await store.load()).tokens)
      check(!requests.some((request) => request.path === "/oauth/register"))
    } else if (stage === "denial") {
      let denied = false
      try {
        await signIn()
      } catch (error) {
        denied = error instanceof Error && error.message === "access_denied"
      }
      check(denied && authorization && !(await store.load()).tokens)
      check(!requests.some((request) => request.path === "/oauth/token"))
    } else {
      check(loginStages.includes(stage) || ["refresh", "restart"].includes(stage))
      if (loginStages.includes(stage)) {
        checkpoint("sign-in")
        await signIn()
        check(authorization)
        checkpoint("connect")
        await connection.reconnect()
      } else await connection.getClient()
      check(connection.state === "connected")
      check(
        JSON.stringify(connection.tools.map((tool) => tool.name).sort()) ===
          JSON.stringify([...tools].sort()),
      )
      const content = `# Installed Pi OAuth fixture: ${stage}`
      const call = async (name, args) => {
        const result = await connection.callTool(name, args, {
          signal: AbortSignal.timeout(15_000),
        })
        check(!result.isError && result.structuredContent)
        return result.structuredContent
      }
      // Exactly one explicit creation, one consuming read, and one revocation.
      // No automatic mutation retry is added by this harness.
      checkpoint("create")
      const created = await call("create_share", { content, max_views: 2 })
      check(typeof created.id === "string")
      const share = new URL(created.share_url)
      check(share.origin === origin)
      const token = (share.hash || share.pathname).split("/").pop()
      remember(token)
      shareSecrets.add(token)
      await inspect(created.id, 0)
      checkpoint("read")
      const consumed = await call("get_share", { token })
      check(
        consumed.content === content && consumed.view_count === 1 && consumed.views_remaining === 1,
      )
      await inspect(created.id, 1)
      checkpoint("revoke")
      const revoked = await call("revoke_share", { id: created.id })
      check(revoked.id === created.id && revoked.revoked === true)
      await inspect(created.id, 1, true)
      for (const tool of tools)
        check(
          requests.filter((request) => request.method === "tools/call" && request.tool === tool)
            .length === 1,
        )
    }
    checkpoint("persistence")
    const after = await store.load()
    rememberState(after)
    if (before?.clientInformation)
      check(after.clientInformation.client_id === before.clientInformation.client_id)
    if (stage === "reuse")
      check(
        authorization.searchParams.get("redirect_uri") ===
          before.clientInformation.redirect_uris[0],
      )
    if (stage !== "login") check(!requests.some((request) => request.path === "/oauth/register"))
    if (loginStages.includes(stage))
      check(after.tokens?.refresh_token && after.tokens.scope === scope)
    if (stage === "login") {
      for (const path of [
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
        "/oauth/register",
      ])
        check(requests.some((request) => request.path === path && request.status < 300))
    }
    if (stage === "refresh") {
      check(!authorization && before.tokensExpireAt > Date.now())
      check(
        after.tokens.access_token !== before.tokens.access_token &&
          after.tokens.refresh_token !== before.tokens.refresh_token,
      )
      check(requests.some((request) => request.path === "/mcp" && request.status === 401))
      check(
        requests.filter(
          (request) =>
            request.path === "/oauth/token" &&
            request.grant === "refresh_token" &&
            request.status === 200,
        ).length === 1,
      )
    }
    if (stage === "restart") {
      check(!authorization && after.tokens.access_token === before.tokens.access_token)
      check(!requests.some((request) => request.path === "/oauth/token"))
    }
    checkpoint("close")
    await connection.close()
    connection = undefined
    check(((await stat(join(profile, "mcp-auth.json"))).mode & 0o777) === 0o600)
    send({
      type: "complete",
      secrets: [...secrets],
      shareSecrets: [...shareSecrets],
      counts: {
        registrations: requests.filter((request) => request.path === "/oauth/register").length,
        codeExchanges: requests.filter((request) => request.grant === "authorization_code").length,
        refreshes: requests.filter((request) => request.grant === "refresh_token").length,
        refreshRotations: requests.filter(
          (request) => request.grant === "refresh_token" && request.status === 200,
        ).length,
        rejectedRefreshes: requests.filter(
          (request) => request.grant === "refresh_token" && request.status === 400,
        ).length,
        toolCalls: requests.filter((request) => request.method === "tools/call").length,
        authorizationPages: authorization ? 1 : 0,
      },
    })
  } finally {
    await connection?.close()
    globalThis.fetch = originalFetch
  }
}

async function main() {
  process.umask(0o077)
  // Playwright debug logging can include fill values and authorization URLs.
  // PWDEBUG can open an inspector. This gate permits neither behavior.
  delete process.env.DEBUG
  delete process.env.PWDEBUG
  let phase = "arguments"
  let directory
  let reportDirectory
  let browser
  let browserStarting
  let cleanedUp = false
  let databaseAttempted = false
  let helper
  let env
  let service
  let stopping = false
  let cleanupPromise
  let failed = false
  const children = new Set()
  const secrets = new Set()
  const shareSecrets = new Set()
  const requests = []
  const consoleMessages = []
  const contexts = []
  const validatedCallbacks = new Set()
  const authenticators = new Map()
  const captures = []
  const phases = []
  const counts = {
    processes: 0,
    registrations: 0,
    codeExchanges: 0,
    refreshes: 0,
    refreshRotations: 0,
    rejectedRefreshes: 0,
    toolCalls: 0,
    authorizationPages: 0,
  }
  const databaseName = `morsel_auth_e2e_${randomBytes(12).toString("hex")}`
  let page
  let context
  let accountID
  let origin
  let expectedCallback
  let browserViolation = false
  let piVersion
  const authenticationResponses = {
    begin: 0,
    finish: 0,
    beginStatus: 0,
    finishStatus: 0,
    residentCredentials: 0,
    assertions: 0,
  }
  let failureKind

  function remember(value) {
    check(typeof value === "string" && value.length >= 32)
    secrets.add(value)
  }
  function track(child) {
    children.add(child)
    child.once("close", () => children.delete(child))
    return child
  }
  async function stop(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    await new Promise((done) => {
      const kill = (signal) => {
        try {
          if (process.platform === "win32") child.kill(signal)
          else process.kill(-child.pid, signal)
        } catch {
          /* The owned process already exited. */
        }
      }
      const timer = setTimeout(() => kill("SIGKILL"), 5_000)
      child.once("close", () => {
        clearTimeout(timer)
        done()
      })
      kill("SIGTERM")
    })
  }
  async function command(
    file,
    args,
    { input, capture = false, cwd = root, childEnv = env ?? process.env, cleanup = false } = {},
  ) {
    check(!stopping || cleanup)
    return new Promise((done, reject) => {
      const child = track(
        spawn(file, args, {
          cwd,
          env: childEnv,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        }),
      )
      let output = ""
      child.stdout.on("data", (chunk) => {
        if (capture) output += chunk
      })
      // Tool output can contain credentials. Never inherit stdout or stderr.
      child.stderr.resume()
      const timer = setTimeout(() => {
        void stop(child)
        reject(new Error("Command timeout"))
      }, 180_000)
      child.once("error", () => {
        clearTimeout(timer)
        reject(new Error("Command failed"))
      })
      child.once("close", (code) => {
        clearTimeout(timer)
        if (code === 0) done(output.trim())
        else reject(new Error("Command failed"))
      })
      child.stdin.on("error", () => {})
      child.stdin.end(input)
    })
  }
  function cleanup() {
    cleanupPromise ??= (async () => {
      stopping = true
      let error = false
      try {
        const launched = await browserStarting?.catch(() => undefined)
        await (browser ?? launched)?.close()
      } catch {
        error = true
      }
      await Promise.all([...children].map(stop))
      try {
        if (databaseAttempted)
          await command(helper, ["database-drop", databaseName], { cleanup: true })
      } catch {
        error = true
      } finally {
        if (directory)
          await rm(directory, { recursive: true, force: true }).catch(() => {
            error = true
          })
      }
      check(!error)
    })()
    return cleanupPromise
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      void cleanup().then(
        () => process.exit(signal === "SIGINT" ? 130 : 143),
        () => {
          console.error("FAIL cleanup")
          process.exit(1)
        },
      )
    })
  }
  async function availablePort() {
    const server = createServer()
    await new Promise((done, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", done)
    })
    const { port } = server.address()
    await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())))
    return port
  }
  async function startServer() {
    check(!stopping)
    const log = await open(join(directory, "server.log"), "a", 0o600)
    try {
      check(!stopping)
      service = track(
        spawn(join(directory, "server"), [], {
          cwd: directory,
          env,
          detached: process.platform !== "win32",
          stdio: ["ignore", log.fd, log.fd],
        }),
      )
      service.on("error", () => {})
    } finally {
      await log.close()
    }
    for (let attempt = 0; attempt < 200; attempt++) {
      check(!stopping && service.exitCode === null && service.signalCode === null)
      try {
        const response = await fetch(`${origin}/v1/account`, { signal: AbortSignal.timeout(1_000) })
        if (response.ok && typeof (await response.json()).setup_required === "boolean") return
      } catch {
        /* Retry readiness only, never protocol or share mutations. */
      }
      await pause(100)
    }
    throw new Error("Readiness failed")
  }
  async function account(target = page) {
    const response = await target.request.get(`${origin}/v1/account`)
    check(response.status() === 200 && response.headers()["cache-control"].includes("no-store"))
    const state = await response.json()
    if (state.authenticated) check(response.headers()["x-morsel-account-id"] === state.account_id)
    return state
  }
  async function newBrowserPage() {
    const created = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1280, height: 1000 },
      serviceWorkers: "block",
    })
    contexts.push(created)
    // No traces, videos, HAR files, or persisted browser storage snapshots.
    created.on("request", (request) => {
      try {
        const url = new URL(request.url())
        const referer = request.headers().referer ?? ""
        requests.push({ url: url.href, referer }) // Private memory, never a report.
        if (url.searchParams.has("code")) {
          check(
            expectedCallback &&
              url.origin === expectedCallback.redirect.origin &&
              url.pathname === expectedCallback.redirect.pathname,
          )
          check(
            url.searchParams.get("state") === expectedCallback.state &&
              url.searchParams.get("iss") === origin,
          )
          check(/^moc_[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code")))
          remember(url.searchParams.get("code"))
          validatedCallbacks.add(url.href)
        }
        if (url.origin !== origin) {
          check(expectedCallback && url.origin === expectedCallback.redirect.origin)
          check(
            url.pathname === expectedCallback.redirect.pathname || url.pathname === "/favicon.ico",
          )
          check(!referer)
        }
        check(
          !url.searchParams.has("code_verifier") &&
            !url.searchParams.has("access_token") &&
            !url.searchParams.has("refresh_token"),
        )
      } catch {
        browserViolation = true
      }
    })
    const target = await created.newPage()
    target.setDefaultTimeout(15_000)
    target.on("response", (response) => {
      const path = new URL(response.url()).pathname
      for (const step of ["begin", "finish"]) {
        if (path === `/v1/auth/login/${step}`) {
          authenticationResponses[step]++
          authenticationResponses[`${step}Status`] = response.status()
        }
      }
    })
    target.on("console", (message) => consoleMessages.push(message.text()))
    target.on("pageerror", () => {
      browserViolation = true
    })
    const cdp = await created.newCDPSession(target)
    await cdp.send("WebAuthn.enable")
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    authenticators.set(target, { cdp, authenticatorId })
    cdp.on("WebAuthn.credentialAsserted", () => {
      authenticationResponses.assertions++
    })
    return { page: target, context: created, cdp }
  }
  async function visible(locator) {
    await locator.waitFor({ state: "visible" })
  }
  async function signedIn() {
    await visible(page.getByRole("button", { name: "Account", exact: true }))
  }
  async function logout() {
    await page.goto(`${origin}/account`)
    await signedIn()
    await page.getByRole("button", { name: "Account", exact: true }).click()
    const [completion] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/auth/logout"),
      page.getByRole("menuitem", { name: "Log out", exact: true }).click(),
    ])
    check(completion.status() === 204)
    await visible(page.getByRole("button", { name: "Sign in with passkey", exact: true }))
  }
  async function oauthCounts() {
    return JSON.parse(await command(helper, ["oauth-counts", accountID], { capture: true }))
  }
  async function noBrowserSecrets(target = page) {
    check(new URL(target.url()).origin === origin)
    const persisted = await target.evaluate(async () => {
      const values = [
        location.href,
        JSON.stringify(history.state),
        JSON.stringify(localStorage),
        JSON.stringify(sessionStorage),
        document.body.textContent,
        ...Array.from(document.querySelectorAll("input"), (input) => input.value),
      ]
      for (const entry of await indexedDB.databases()) {
        if (!entry.name) continue
        const db = await new Promise((done, reject) => {
          const request = indexedDB.open(entry.name)
          request.onsuccess = () => done(request.result)
          request.onerror = () => reject(new Error("Storage inspection failed"))
        })
        try {
          for (const name of db.objectStoreNames) {
            const value = await new Promise((done, reject) => {
              const request = db.transaction(name).objectStore(name).getAll()
              request.onsuccess = () => done(request.result)
              request.onerror = () => reject(new Error("Storage inspection failed"))
            })
            values.push(JSON.stringify(value))
          }
        } finally {
          db.close()
        }
      }
      return values.join("\n")
    })
    for (const secret of secrets) check(!persisted.includes(secret))
    // Inspect all retained history entries, not only history.state. Codes may
    // occur only on the previously validated loopback callback entry.
    // Reuse the WebAuthn session. Detaching a second CDP session can discard
    // Chromium's target-scoped virtual authenticator and its resident keys.
    const history = await authenticators.get(target).cdp.send("Page.getNavigationHistory")
    for (const entry of history.entries) {
      for (const secret of secrets) {
        if (!entry.url.includes(secret)) continue
        check(secret.startsWith("moc_") && validatedCallbacks.has(entry.url))
      }
    }
  }
  async function browserAuthorization(message, stage) {
    phase = `${stage}/browser-navigation`
    for (const secret of message.secrets) remember(secret)
    const url = new URL(message.url)
    const redirect = new URL(url.searchParams.get("redirect_uri"))
    check(url.origin === origin && url.pathname === "/oauth/authorize")
    check(
      redirect.protocol === "http:" &&
        redirect.hostname === "127.0.0.1" &&
        redirect.pathname === "/callback" &&
        redirect.port &&
        !redirect.search &&
        !redirect.hash,
    )
    expectedCallback = { redirect, state: url.searchParams.get("state") }
    const before = await oauthCounts()
    await page.goto(url.href)
    if (!(await account()).authenticated) {
      phase = `${stage}/passkey-login`
      await page.bringToFront()
      await visible(page.getByRole("button", { name: "Sign in with passkey", exact: true }))
      phase = `${stage}/resident-passkey`
      const authenticator = authenticators.get(page)
      const { credentials } = await authenticator.cdp.send("WebAuthn.getCredentials", {
        authenticatorId: authenticator.authenticatorId,
      })
      authenticationResponses.residentCredentials = credentials.length
      check(
        credentials.length === 1 &&
          credentials[0].isResidentCredential &&
          credentials[0].rpId === "localhost",
      )
      phase = `${stage}/passkey-click`
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/v1/auth/login/finish",
        ),
        page.getByRole("button", { name: "Sign in with passkey", exact: true }).click(),
      ])
      phase = response.status() === 200 ? `${stage}/passkey-complete` : `${stage}/passkey-rejected`
      check(response.status() === 200)
    }
    phase = `${stage}/consent-display`
    await visible(page.getByRole("heading", { name: "Connect app", exact: true }))
    await visible(page.getByRole("button", { name: "Approve access", exact: true }))
    check(new URL(page.url()).pathname === "/oauth/consent")
    for (const text of [
      `Account: Owner`,
      `Account ID: ${accountID}`,
      "pi",
      url.searchParams.get("client_id"),
      redirect.host,
      `${origin}/mcp`,
      scope,
    ])
      await visible(page.getByText(text, { exact: true }))
    await visible(page.getByText(/The app name is unverified\./))
    await visible(page.getByText(/Persistent access: up to 30 days/))
    phase = `${stage}/no-get-issuance`
    const displayedCounts = await oauthCounts()
    // Production cleanup can remove expired token rows after a backend restart.
    // A GET must not increase either count or issue a new grant.
    check(displayedCounts.grants === before.grants && displayedCounts.tokens <= before.tokens)
    phase = `${stage}/consent-privacy`
    await noBrowserSecrets()
    if (stage === "login") {
      const capture = await page.screenshot({ animations: "disabled", fullPage: true })
      captures.push({ name: "consent-fixture.png", body: capture })
    }
    phase = `${stage}/consent-decision`
    const [response] = await Promise.all([
      page
        .waitForResponse(
          (response) =>
            new URL(response.url()).pathname.startsWith("/v1/account/oauth/requests/") &&
            response.request().method() === "POST",
        )
        .then(async (response) => ({
          status: response.status(),
          marker: response.headers()["x-morsel-account-id"],
          // Read before the loopback navigation releases this document's body.
          redirect: (await response.json()).redirect_url,
        })),
      page.waitForURL(
        (value) => value.origin === redirect.origin && value.pathname === redirect.pathname,
      ),
      page
        .getByRole("button", {
          name: stage === "denial" ? "Deny access" : "Approve access",
          exact: true,
        })
        .click(),
    ])
    phase = `${stage}/consent-callback`
    check(response.status === 200 && response.marker === accountID)
    const returned = new URL(response.redirect)
    check(returned.origin === redirect.origin && returned.pathname === redirect.pathname)
    check(
      returned.searchParams.get("state") === expectedCallback.state &&
        returned.searchParams.get("iss") === origin,
    )
    if (stage === "denial")
      check(
        returned.searchParams.get("error") === "access_denied" &&
          !returned.searchParams.has("code"),
      )
    else remember(returned.searchParams.get("code"))
    if (stage === "denial") {
      const deniedCounts = await oauthCounts()
      check(
        deniedCounts.grants === displayedCounts.grants &&
          deniedCounts.tokens === displayedCounts.tokens,
      )
    }
    // The consent page uses location.replace; inspect browser history later.
    phase = `${stage}/browser-return`
    await page.goto(`${origin}/account`)
    await signedIn()
    await noBrowserSecrets()
  }
  async function piStage(stage, piDirectory) {
    phase = stage
    check(!stopping)
    const child = track(
      spawn(process.execPath, [script, "--worker"], {
        cwd: join(directory, "workspace"),
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
    )
    let diagnostic = ""
    child.stdout.on("data", (chunk) => {
      diagnostic += chunk
    })
    child.stderr.on("data", (chunk) => {
      diagnostic += chunk
    })
    counts.processes++
    await new Promise((done, reject) => {
      let result
      let work = Promise.resolve()
      const timer = setTimeout(() => {
        void stop(child)
        reject(new Error("Pi stage timeout"))
      }, 90_000)
      child.on("message", (message) => {
        work = work
          .then(async () => {
            if (message.type === "checkpoint") {
              check(checkpoints.includes(message.name))
              phase = `${stage}/${message.name}`
            } else if (message.type === "authorize") await browserAuthorization(message, stage)
            else if (message.type === "inspect") {
              const response = await context.request.get(
                `${origin}/v1/account/shares/${message.share}`,
              )
              check(
                response.status() === 200 &&
                  response.headers()["x-morsel-account-id"] === accountID,
              )
              const detail = await response.json()
              check(detail.view_count === message.count && !!detail.revoked_at === message.revoked)
              child.send({ type: "inspected", id: message.id, ok: true })
            } else if (message.type === "complete") {
              result = message
              for (const secret of message.secrets) remember(secret)
              for (const secret of message.shareSecrets) shareSecrets.add(secret)
            } else throw new Error("Pi stage failed")
          })
          .catch((error) => {
            failureKind ??= error?.name === "TimeoutError" ? "timeout" : "check"
            child.send({ type: "cancel" }, () => {})
            void stop(child)
            reject(new Error("Pi stage failed"))
          })
      })
      child.once("error", () => {
        clearTimeout(timer)
        reject(new Error("Pi stage failed"))
      })
      child.once("close", (code) => {
        clearTimeout(timer)
        void work
          .then(() => {
            if (code !== 0 || !result) reject(new Error("Pi stage failed"))
            else {
              for (const secret of secrets) check(!diagnostic.includes(secret))
              check(!diagnostic.trim())
              for (const name of Object.keys(result.counts)) counts[name] += result.counts[name]
              done()
            }
          })
          .catch(reject)
      })
      child.send({ directory, piDirectory, origin, stage })
    })
    phases.push(stage)
  }
  async function savedAccess() {
    const states = JSON.parse(await readFile(join(directory, "pi/mcp-auth.json"), "utf8"))
    const entries = Object.values(states)
    check(entries.length === 1 && entries[0].tokens?.access_token)
    return entries[0].tokens.access_token
  }

  try {
    const args = process.argv.slice(2)
    let piDirectory
    let requestedReport
    for (let index = 0; index < args.length; index += 2) {
      check(args[index + 1])
      if (args[index] === "--pi-directory" && !piDirectory) piDirectory = args[index + 1]
      else if (args[index] === "--report-directory" && !requestedReport)
        requestedReport = args[index + 1]
      else check(false)
    }
    check(piDirectory && isAbsolute(piDirectory) && process.env.MORSEL_TEST_DATABASE_URL)
    const pi = JSON.parse(await readFile(join(piDirectory, "package.json"), "utf8"))
    check(
      pi.name === "@earendil-works/pi-coding-agent" &&
        /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(pi.version),
    )
    piVersion = pi.version
    directory = await mkdtemp(join(tmpdir(), "morsel-mcp-oauth-pi-"))
    await chmod(directory, 0o700)
    for (const name of ["pi", "home", "cache", "workspace", "browser"])
      await mkdir(join(directory, name), { mode: 0o700 })
    if (requestedReport) {
      check(isAbsolute(requestedReport))
      const destination = resolve(requestedReport)
      await mkdir(destination, { mode: 0o700 }) // Never overwrite an existing report.
      reportDirectory = destination
    } else {
      const base = join(root, "packages/viewer/test-results") // Git-ignored; no images are committed.
      await mkdir(base, { recursive: true })
      reportDirectory = await mkdtemp(join(base, "mcp-oauth-pi-"))
    }
    env = {
      ...process.env,
      GOTOOLCHAIN: "go1.26.11",
      MORSEL_ENVIRONMENT: "development",
      PI_CODING_AGENT_DIR: join(directory, "pi"),
      HOME: join(directory, "home"),
      XDG_CACHE_HOME: join(directory, "cache"),
      TMPDIR: join(directory, "browser"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    }
    // No inherited credential/configuration or proxy can replace URL-only OAuth.
    for (const name of Object.keys(env)) {
      if (
        (name.startsWith("MORSEL_") &&
          name !== "MORSEL_TEST_DATABASE_URL" &&
          name !== "MORSEL_ENVIRONMENT") ||
        /^(?:https?|all)_proxy$/i.test(name) ||
        name.startsWith("PI_SESSION") ||
        name === "PI_PACKAGE_DIR"
      )
        delete env[name]
    }
    helper = join(directory, "test-auth")
    phase = "build"
    // Use Vite's real production build, with all generated output under our temp
    // directory. Do not overwrite another browser worker's viewer/dist output.
    await command(
      process.execPath,
      [
        join(root, "node_modules/vite/bin/vite.js"),
        "build",
        "--outDir",
        join(directory, "viewer"),
        "--emptyOutDir",
      ],
      { cwd: join(root, "packages/viewer") },
    )
    for (const name of ["server", "migrate", "account", "test-auth"])
      await command(
        "go",
        ["build", "-mod=readonly", "-o", join(directory, name), `./cmd/${name}`],
        { cwd: join(root, "packages/server") },
      )
    phase = "database"
    databaseAttempted = true
    const databaseURL = await command(helper, ["database-create", databaseName], { capture: true })
    check(databaseURL)
    const port = await availablePort()
    origin = `http://localhost:${port}`
    Object.assign(env, {
      MORSEL_DATABASE_URL: databaseURL,
      MORSEL_URL: origin,
      MORSEL_ADDRESS: `127.0.0.1:${port}`,
      MORSEL_VIEWER_DIR: join(directory, "viewer"),
    })
    await command(join(directory, "migrate"), [])
    await startServer()
    phase = "enrollment"
    process.env.TMPDIR = join(directory, "browser")
    const { chromium } = await import("@playwright/test")
    check(!stopping)
    browserStarting = chromium.launch({ headless: true, env })
    browser = await browserStarting
    check(!stopping)
    ;({ page, context } = await newBrowserPage())
    const setup = await command(join(directory, "account"), ["-kind", "setup"], { capture: true })
    remember(setup)
    await page.goto(`${origin}/account`)
    await page.getByLabel("Setup token", { exact: true }).fill(setup)
    await page.getByLabel("Passkey name", { exact: true }).fill("Pi fixture resident passkey")
    await page.bringToFront()
    const [completion] = await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/v1/auth/setup/finish",
      ),
      page.getByRole("button", { name: "Set up account", exact: true }).click(),
    ])
    check(completion.status() === 200)
    await signedIn()
    const initialAccount = await account()
    check(
      initialAccount.authenticated &&
        initialAccount.role === "admin" &&
        initialAccount.display_name === "Owner",
    )
    accountID = initialAccount.account_id
    check((await oauthCounts()).grants === 0)
    await noBrowserSecrets()
    await logout() // First Pi authorization must perform a real passkey login.
    phases.push("enrollment")
    await piStage("login", piDirectory)
    await piStage("reuse", piDirectory)
    phase = "expire-access"
    const expiredAccess = await savedAccess()
    await command(helper, ["expire-oauth-access"], { input: expiredAccess })
    await piStage("refresh", piDirectory)
    phase = "backend-restart"
    await stop(service)
    await startServer() // Same binary, database, configured issuer, and port.
    await piStage("restart", piDirectory)
    await piStage("denial", piDirectory)
    await piStage("authorize-revocation", piDirectory)
    phase = "revoke-grant"
    const response = await context.request.get(`${origin}/v1/account/oauth/grants`)
    check(response.status() === 200)
    const grants = await response.json()
    const grant = grants[0]
    check(grant && !grant.revoked_at)
    await page.goto(`${origin}/account`)
    await page.getByRole("button", { name: `Revoke app pi (${grant.id})`, exact: true }).click()
    const [revocation] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/v1/account/oauth/grants/${grant.id}` &&
          response.request().method() === "DELETE",
      ),
      page.getByRole("button", { name: "Confirm revoke app", exact: true }).click(),
    ])
    check(revocation.status() === 204)
    const afterRevocation = await (
      await context.request.get(`${origin}/v1/account/oauth/grants`)
    ).json()
    check(afterRevocation.find((item) => item.id === grant.id).revoked_at)
    for (const other of grants.filter((item) => item.id !== grant.id))
      check(afterRevocation.find((item) => item.id === other.id).revoked_at === other.revoked_at)
    await piStage("revoked", piDirectory)
    await piStage("reauthorize-revocation", piDirectory)
    phase = "recovery"
    const oldPage = page
    const recovery = await command(
      join(directory, "account"),
      ["-kind", "recover", "-account-id", accountID],
      { capture: true },
    )
    remember(recovery)
    ;({ page, context } = await newBrowserPage())
    await page.goto(`${origin}/recover?next=%2Faccount`)
    await page.getByLabel("Recovery token", { exact: true }).fill(recovery)
    await page
      .getByLabel("Replacement passkey name", { exact: true })
      .fill("Pi fixture replacement resident passkey")
    await page.bringToFront()
    const [recovered] = await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/v1/auth/recover/finish",
      ),
      page.getByRole("button", { name: "Recover account", exact: true }).click(),
    ])
    check(recovered.status() === 200)
    await signedIn()
    check((await account()).account_id === accountID && !(await account(oldPage)).authenticated)
    await noBrowserSecrets()
    phases.push("recovery")
    await piStage("recovered", piDirectory)
    await logout() // Reauthorization uses the replacement resident passkey.
    await piStage("reauthorize-recovery", piDirectory)
    phase = "audit/browser-storage"
    for (const candidate of contexts) {
      for (const target of candidate.pages()) {
        await target.goto(`${origin}/account`)
        await noBrowserSecrets(target)
      }
    }
    phase = "audit/browser-requests"
    check(!browserViolation && requests.length > 0)
    phase = "audit/server-log"
    const logs = await readFile(join(directory, "server.log"), "utf8")
    check(logs.length > 0 && !/\bmo[acr]_[A-Za-z0-9_-]{43}\b|code_verifier=/.test(logs))
    for (const secret of secrets) {
      phase = "audit/log-secrets"
      check(!logs.includes(secret) && !consoleMessages.some((message) => message.includes(secret)))
      phase = "audit/referrer-secrets"
      for (const request of requests) {
        check(!request.referer.includes(secret))
        if (request.url.includes(secret)) {
          check(secret.startsWith("moc_") && validatedCallbacks.has(request.url))
        }
      }
      phase = "audit/database-secrets"
      // Existing share-link recovery deliberately stores raw capabilities.
      // Hash-only persistence is required for OAuth/setup/recovery credentials,
      // not a change to that separate, established share-link contract.
      if (!shareSecrets.has(secret)) await command(helper, ["assert-no-secret"], { input: secret })
    }
    phase = "audit/permissions"
    check(
      ((await stat(directory)).mode & 0o777) === 0o700 &&
        ((await stat(join(directory, "pi"))).mode & 0o777) === 0o700,
    )
    phase = "audit/profile-files"
    check((await readdir(join(directory, "pi"))).every((name) => name === "mcp-auth.json"))
    phase = "audit/counts"
    check(
      counts.registrations === 1 &&
        counts.codeExchanges === 5 &&
        counts.toolCalls === 21 &&
        counts.authorizationPages === 6,
    )
    check(counts.refreshRotations === 1 && counts.rejectedRefreshes === 2 && counts.refreshes === 3)
    check(
      authenticationResponses.begin === 2 &&
        authenticationResponses.finish === 2 &&
        authenticationResponses.assertions >= 2,
    )
    phases.push("audit")
    // Only the consent image and this fixed-shape evidence survive cleanup.
    phase = "audit/captures"
    for (const capture of captures) {
      for (const secret of secrets) check(!capture.body.includes(Buffer.from(secret)))
      await writeFile(join(reportDirectory, capture.name), capture.body, {
        mode: 0o600,
        flag: "wx",
      })
    }
  } catch (error) {
    failed = true
    failureKind ??= error?.name === "TimeoutError" ? "timeout" : "check"
    console.error(`FAIL ${phase}`)
  } finally {
    try {
      await cleanup()
      cleanedUp = true
    } catch {
      failed = true
      console.error("FAIL cleanup")
    }
    if (reportDirectory) {
      const summary = {
        passed: !failed,
        phase,
        piVersion,
        driver,
        cleanedUp,
        headless: true,
        disposablePostgres: true,
        privateCredentialStore: true,
        traces: false,
        videos: false,
        phases,
        counts,
        authenticationResponses,
        failureKind,
        captures: failed ? 0 : captures.length,
      }
      try {
        await writeFile(
          join(reportDirectory, "summary.json"),
          `${JSON.stringify(summary, null, 2)}\n`,
          { mode: 0o600, flag: "wx" },
        )
      } catch {
        failed = true
        console.error("FAIL report")
      }
    }
    process.exitCode = failed ? 1 : 0
  }
  if (!failed)
    console.log(
      `PASS phases=${phases.length} processes=${counts.processes} registrations=${counts.registrations} code-exchanges=${counts.codeExchanges} refreshes=${counts.refreshes} tool-calls=${counts.toolCalls} captures=${captures.length}`,
    )
}

if (process.argv[2] === "--worker" && typeof process.send === "function") {
  try {
    await worker()
  } catch {
    process.send({ type: "failed" })
    process.exitCode = 1
  } finally {
    process.disconnect()
  }
} else await main()
