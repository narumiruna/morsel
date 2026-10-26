import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type BrowserContext, type CDPSession, expect, type Page, test } from "@playwright/test"
import { MorselClient } from "../../client/src/index"

async function revokeShare(page: Page, label: string) {
  await page.getByRole("button", { name: `More actions for ${label}`, exact: true }).click()
  await page.getByRole("menuitem", { name: `Revoke share ${label}`, exact: true }).click()
  await expect(
    page.getByRole("heading", { name: `Revoke share ${label}?`, exact: true }),
  ).toBeFocused()
}

function command(file: string, args: string[], input?: string, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "ignore"] })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.on("error", () => reject(new Error("Test command could not start")))
    child.on("exit", (code) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error("Test command failed (credential details suppressed)"))
    })
    child.stdin.end(input)
  })
}

async function cliRevokeDenied(id: string, origin: string, key: string) {
  // Keep command diagnostics out of reports: they can contain credentials.
  const rejected = await new Promise<boolean>((finish, reject) => {
    const child = spawn(
      "uv",
      ["run", "python", resolve("../../skills/morsel-share-markdown/scripts/revoke-share.py"), id],
      {
        env: { ...process.env, MORSEL_URL: origin, MORSEL_API_KEY: key },
        stdio: ["ignore", "ignore", "pipe"],
      },
    )
    let diagnostic = ""
    child.stderr.on("data", (chunk) => {
      diagnostic += chunk
    })
    child.on("error", () => reject(new Error("CLI test could not start")))
    child.on("exit", (code) => finish(code !== 0 && /HTTP 404\b/.test(diagnostic)))
  })
  expect(rejected).toBe(true)
}

async function authenticator(cdp: CDPSession) {
  return (
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
  ).authenticatorId as string
}

async function account(page: Page) {
  const response = await page.request.get("/v1/account")
  expect(response.status()).toBe(200)
  expect(response.headers()["cache-control"]).toContain("no-store")
  const state = await response.json()
  if (state.authenticated) {
    expect(typeof state.account_id).toBe("string")
    expect(typeof state.display_name).toBe("string")
    expect(response.headers()["x-morsel-account-id"]).toBe(state.account_id)
  }
  return state
}

async function expectSignedIn(page: Page) {
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
}

async function logOut(page: Page) {
  await page.bringToFront()
  await page.getByRole("button", { name: "Account", exact: true }).click()
  const completion = page.waitForResponse((response) => response.url().endsWith("/v1/auth/logout"))
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click()
  expect((await completion).status()).toBe(204)
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
}

async function openSection(page: Page, name: "Shares" | "API keys" | "Security") {
  const dismiss = page.getByRole("button", { name: "Dismiss API key", exact: true })
  if (await dismiss.isVisible()) await dismiss.click()
  await page.getByRole("link", { name, exact: true }).click()
  await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
}

async function login(page: Page, destination = "/account") {
  await page.bringToFront()
  await page.goto(destination)
  const completion = page.waitForResponse((response) =>
    response.url().endsWith("/v1/auth/login/finish"),
  )
  await page.getByRole("button", { name: "Sign in with passkey", exact: true }).click()
  expect((await completion).status()).toBe(200)
  await expectSignedIn(page)
  await expect(page).toHaveURL(new URL(destination, page.url()).href)
  expect((await account(page)).authenticated).toBe(true)
}

async function noBrowserSecret(page: Page, secret: string) {
  const persisted = await page.evaluate(async (raw) => {
    if (
      JSON.stringify(localStorage).includes(raw) ||
      JSON.stringify(sessionStorage).includes(raw)
    ) {
      return true
    }
    for (const entry of await indexedDB.databases()) {
      if (!entry.name) continue
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(entry.name as string)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error("Cannot inspect browser database"))
      })
      try {
        for (const name of database.objectStoreNames) {
          const values = await new Promise<unknown[]>((resolve, reject) => {
            const request = database.transaction(name).objectStore(name).getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(new Error("Cannot inspect browser storage"))
          })
          if (JSON.stringify(values).includes(raw)) return true
        }
      } finally {
        database.close()
      }
    }
    return false
  }, secret)
  expect(persisted).toBe(false)
}

async function createKey(page: Page, name: string) {
  if (!page.url().endsWith("/manage/api-keys")) await openSection(page, "API keys")
  const dismiss = page.getByRole("button", { name: "Dismiss API key", exact: true })
  if (await dismiss.isVisible()) await dismiss.click()
  await page.getByLabel("API key name", { exact: true }).fill(name)
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/v1/api-keys") && response.request().method() === "POST",
  )
  await page.getByRole("button", { name: "Create API key", exact: true }).click()
  const response = await created
  expect(response.status()).toBe(201)
  expect(response.headers()["x-morsel-account-id"]).toBe((await account(page)).account_id)
  const metadata = await response.json()
  expect(typeof metadata.key === "string" && metadata.key.length >= 43).toBe(true)
  expect(
    (await page.getByLabel("New API key", { exact: true }).inputValue()) === metadata.key,
  ).toBe(true)
  await noBrowserSecret(page, metadata.key)
  await command(process.env.MORSEL_AUTH_TEST_HELPER as string, ["assert-no-secret"], metadata.key)
  return metadata as { id: string; key: string; name: string }
}

test("required real-backend account and API key lifecycle", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname
    if (path.startsWith("/v1/auth/") && !response.ok()) {
      console.log(`Authentication response: ${path} ${response.status()}`)
    }
  })
  const helper = process.env.MORSEL_AUTH_TEST_HELPER as string
  const accountCLI = process.env.MORSEL_AUTH_TEST_ACCOUNT as string
  const cdp = await context.newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  const primary = await authenticator(cdp)
  let firstKey: { id: string; key: string; name: string }
  let recoveryKey: { id: string; key: string; name: string }
  let shareURL = ""
  let accountA = ""
  let accountB = ""
  let secondContext: BrowserContext
  let secondPage: Page
  let secondKey: { id: string; key: string; name: string }
  let legacyID = ""

  await test.step("operator setup, secure session, and closed registration", async () => {
    const token = await command(accountCLI, ["-kind", "setup"])
    expect(token.length >= 32).toBe(true)
    await page.goto("/account")
    expect((await account(page)).setup_required).toBe(true)
    await expect(page).toHaveURL(/\/setup\?next=%2Faccount$/)
    await page.reload()
    await expect(page.getByRole("navigation", { name: "Management sections" })).toHaveCount(0)
    await page.getByLabel("Setup token", { exact: true }).fill(token)
    await page.getByLabel("Passkey name", { exact: true }).fill("Primary browser passkey")
    await page.getByRole("button", { name: "Set up account", exact: true }).click()
    await expectSignedIn(page)
    await expect(page).toHaveURL(/\/account$/)
    const state = await account(page)
    expect(state.authenticated).toBe(true)
    accountA = state.account_id
    expect(state.setup_required).toBe(false)
    expect(state.verification_required).toBe(false)
    const cookies = await context.cookies()
    const session = cookies.find((cookie) => cookie.name === "morsel_session")
    expect(session?.httpOnly).toBe(true)
    expect(session?.sameSite).toBe("Lax")
    expect((session?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(29 * 24 * 60 * 60)
    await noBrowserSecret(page, token)
    const rejected = await page.request.post("/v1/auth/setup/begin", {
      headers: { Origin: baseURL as string },
      data: { token, name: "Forbidden second owner" },
    })
    expect(rejected.status() >= 400 && rejected.status() < 500).toBe(true)
    await page.reload()
    await expectSignedIn(page)
  })

  await test.step("real legacy schema fixture upgrades to the enrolled sole owner", async () => {
    // No other context exists and no ceremony is pending during this test-only
    // schema 11 -> 10 -> 11 transition. Wait until all management reads finish.
    await page.waitForLoadState("networkidle")
    legacyID = await command(helper, ["seed-legacy-share", accountA])
    expect((await account(page)).account_id).toBe(accountA)
  })

  await test.step("persistent login reuses verification without extra passkey prompts", async () => {
    const restoredContext = await browser.newContext({
      baseURL,
      storageState: await context.storageState(),
    })
    const restored = await restoredContext.newPage()
    try {
      await restored.goto("/manage/api-keys")
      await expectSignedIn(restored)
      let prompts = 0
      restored.on("request", (request) => {
        if (request.url().endsWith("/v1/auth/verify/begin")) prompts += 1
      })
      await createKey(restored, "Remembered browser")
      await restored
        .getByRole("button", { name: "Revoke API key Remembered browser", exact: true })
        .click()
      await restored.getByRole("button", { name: "Confirm revoke API key", exact: true }).click()
      await expect(
        restored.getByRole("button", { name: "Revoke API key Remembered browser", exact: true }),
      ).toHaveCount(0)
      expect(prompts).toBe(0)
      expect((await account(restored)).verification_required).toBe(false)
    } finally {
      await restoredContext.close()
    }
  })

  await test.step("backup passkey enrollment and last-passkey protection", async () => {
    await openSection(page, "Security")
    const switchDevice = async (route: import("@playwright/test").Route) => {
      // Chromium permits only one internal authenticator per target. The primary
      // completes verification first, then the backup handles registration.
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: primary })
      await authenticator(cdp)
      await route.continue()
    }
    await page.route("**/v1/auth/passkey/begin", switchDevice)
    await page.getByLabel("Passkey name", { exact: true }).fill("Backup browser passkey")
    await page.getByRole("button", { name: "Add passkey", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Remove passkey Backup browser passkey", exact: true }),
    ).toBeVisible()
    await page.unroute("**/v1/auth/passkey/begin", switchDevice)
    const removePrimary = page.getByRole("button", {
      name: "Remove passkey Primary browser passkey",
      exact: true,
    })
    let removals = 0
    const observeRemoval = (request: import("@playwright/test").Request) => {
      if (
        new URL(request.url()).pathname.startsWith("/v1/passkeys/") &&
        request.method() === "DELETE"
      )
        removals += 1
    }
    page.on("request", observeRemoval)
    await removePrimary.click()
    await expect(
      page.getByRole("heading", {
        name: "Remove passkey Primary browser passkey?",
        exact: true,
      }),
    ).toBeVisible()
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(removePrimary).toBeFocused()
    expect(removals).toBe(0)
    const afterCancel = await page.request.get("/v1/passkeys")
    expect(await afterCancel.json()).toHaveLength(2)
    await removePrimary.click()
    await page.getByRole("button", { name: "Confirm remove passkey", exact: true }).click()
    await expect(removePrimary).toHaveCount(0)
    expect(removals).toBe(1)
    page.off("request", observeRemoval)
    await expect(page.getByRole("heading", { name: "Passkeys", exact: true })).toBeFocused()
    const list = await page.request.get("/v1/passkeys")
    const body = await list.json()
    const passkeys = Array.isArray(body) ? body : body.passkeys
    expect(passkeys.length).toBe(1)
    const state = await account(page)
    const rejected = await page.request.delete(
      `/v1/passkeys/${encodeURIComponent(passkeys[0].id)}`,
      {
        headers: { Origin: baseURL as string, "X-CSRF-Token": state.csrf_token },
      },
    )
    expect(rejected.status()).toBe(409)
    expect((await rejected.json()).code).toBe("last_passkey")
    await expect(
      page.getByRole("button", { name: "Remove passkey Backup browser passkey", exact: true }),
    ).toBeDisabled()
  })

  await test.step("one-time API key works with TypeScript client and CLI", async () => {
    firstKey = await createKey(page, "Browser integration")
    const client = new MorselClient({ baseUrl: baseURL as string, apiKey: firstKey.key })
    const share = await client.createShare({
      content: "# Existing public capability",
      expires_in: 3600,
    })
    shareURL = share.share_url
    const publicClient = new MorselClient({ baseUrl: baseURL as string })
    const capability = new URL(shareURL)
    const token = (capability.hash || capability.pathname).split("/").pop() as string
    const consumed = await publicClient.consumeShare(token)
    expect(consumed.content).toBe("# Existing public capability")
    const temporary = await mkdtemp(join(tmpdir(), "morsel-auth-cli-"))
    try {
      const markdown = join(temporary, "share.md")
      await writeFile(markdown, "# CLI compatibility\n")
      const env = { ...process.env, MORSEL_URL: baseURL, MORSEL_API_KEY: firstKey.key }
      const created = JSON.parse(
        await command(
          "uv",
          [
            "run",
            "python",
            resolve("../../skills/morsel-share-markdown/scripts/create-share.py"),
            markdown,
          ],
          undefined,
          env,
        ),
      )
      expect(typeof created.id === "string").toBe(true)
      await command(
        "uv",
        [
          "run",
          "python",
          resolve("../../skills/morsel-share-markdown/scripts/revoke-share.py"),
          created.id,
        ],
        undefined,
        env,
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    const list = await page.request.get("/v1/api-keys")
    const listed = await list.json()
    expect(JSON.stringify(listed).includes(firstKey.key)).toBe(false)
    expect(JSON.stringify(listed).includes("token_hash")).toBe(false)
    const bearerManagement = await page.request.get("/v1/api-keys", {
      headers: { Authorization: `Bearer ${firstKey.key}`, Cookie: "" },
    })
    expect(bearerManagement.status()).toBe(401)
    const noCSRF = await page.request.post("/v1/api-keys", {
      headers: { Origin: baseURL as string },
      data: { name: "Missing CSRF must fail" },
    })
    expect(noCSRF.status()).toBe(403)
    const state = await account(page)
    const wrongOrigin = await page.request.post("/v1/api-keys", {
      headers: { Origin: "https://wrong-origin.invalid", "X-CSRF-Token": state.csrf_token },
      data: { name: "Wrong origin must fail" },
    })
    expect(wrongOrigin.status()).toBe(403)
    const sessionWrite = await page.request.post("/v1/shares", {
      data: { content: "Browser sessions cannot create shares" },
    })
    expect(sessionWrite.status()).toBe(401)
    await page.reload()
    expect(
      await page.evaluate((raw) => document.body.textContent?.includes(raw), firstKey.key),
    ).toBe(false)
    await expect(page.getByLabel("New API key", { exact: true })).toHaveCount(0)
    await noBrowserSecret(page, firstKey.key)
  })

  await test.step("revocation blocks writes but preserves public capability reads", async () => {
    const revoked = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/v1/api-keys/${firstKey.id}`) &&
        response.request().method() === "DELETE",
    )
    await page
      .getByRole("button", { name: "Revoke API key Browser integration", exact: true })
      .click()
    await page.getByRole("button", { name: "Confirm revoke API key", exact: true }).click()
    expect((await revoked).status()).toBe(204)
    const result = await page.request.post("/v1/shares", {
      headers: { Authorization: `Bearer ${firstKey.key}` },
      data: { content: "Revoked key must fail" },
    })
    expect(result.status()).toBe(401)
    const publicPage = await browser.newPage()
    try {
      await publicPage.goto(shareURL)
      await expect(
        publicPage.getByRole("heading", { name: "Existing public capability" }),
      ).toBeVisible()
      await publicPage.reload()
      await expect(
        publicPage.getByRole("heading", { name: "Existing public capability" }),
      ).toBeVisible()
    } finally {
      await publicPage.close()
    }
    recoveryKey = await createKey(page, "Recovery review")
  })

  await test.step("historical shares, non-consuming inspection, and UI revocation", async () => {
    await openSection(page, "Shares")
    await page.getByRole("button", { name: "Refresh shares", exact: true }).click()
    await page
      .getByRole("link", { name: "Preview share Legacy before account", exact: true })
      .click()
    await expect(
      page.getByRole("heading", { name: "Legacy before account", exact: true }),
    ).toBeVisible()
    const legacy = await page.request.get(`/v1/account/shares/${legacyID}`)
    expect(legacy.status()).toBe(200)
    const legacyMetadata = await legacy.json()
    expect(legacyMetadata.view_count).toBe(0)
    expect(legacyMetadata.link_available).toBe(false)
    const legacyLink = await page.request.get(`/v1/account/shares/${legacyID}/link`)
    expect(legacyLink.status()).toBe(404)
    expect((await legacyLink.json()).code).toBe("link_unavailable")
    await page.getByRole("button", { name: "Close share details", exact: true }).click()

    const client = new MorselClient({ baseUrl: baseURL as string, apiKey: recoveryKey.key })
    const imageTarget = await client.createShare({ content: "Image target", max_views: 1 })
    const imageURL = new URL(imageTarget.share_url)
    const imageToken = (imageURL.hash || imageURL.pathname).split("/").pop()
    const managed = await client.createShare({
      content: `# Managed history content\n\n![no consuming image](/v1/shares/${imageToken})\n\n\`\`\`mermaid\nflowchart TD\nA@{ img: "/v1/shares/${imageToken}", label: "test", h: 60 }\n\`\`\``,
      max_views: 1,
      preview: { title: "Managed history", description: "Administrative inspection fixture" },
    })
    const path = `/v1/account/shares/${managed.id}`
    let consumingRequests = 0
    const observe = (request: import("@playwright/test").Request) => {
      if (new URL(request.url()).pathname.startsWith("/v1/shares/") && request.method() === "GET")
        consumingRequests += 1
    }
    page.on("request", observe)
    await page.getByRole("button", { name: "Refresh shares", exact: true }).click()
    await page.getByRole("link", { name: "Preview share Managed history", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Managed history content", exact: true }),
    ).toBeVisible()
    const before = await page.request.get(path)
    expect(before.headers()["cache-control"]).toBe("no-store")
    expect((await before.json()).view_count).toBe(0)
    await expect(page.locator(".share-admin-detail img")).toHaveCount(0)
    await expect(page.locator(".share-admin-detail pre > code.language-mermaid")).toBeVisible()
    await expect(
      page.getByText("Image not loaded: no consuming image", { exact: true }),
    ).toBeVisible()
    expect(consumingRequests).toBe(0)
    const targetDetail = await page.request.get(`/v1/account/shares/${imageTarget.id}`)
    expect((await targetDetail.json()).view_count).toBe(0)
    const listed = await page.request.get("/v1/account/shares")
    const metadata = JSON.stringify(await listed.json())
    expect(metadata).not.toContain("token_hash")
    expect(metadata).not.toContain("# Managed history content")
    const bearerOnly = await page.request.get(path, {
      headers: { Cookie: "", Authorization: `Bearer ${recoveryKey.key}` },
    })
    expect(bearerOnly.status()).toBe(401)
    const bearerLink = await page.request.get(`${path}/link`, {
      headers: { Cookie: "", Authorization: `Bearer ${recoveryKey.key}` },
    })
    expect(bearerLink.status()).toBe(401)
    await test.info().attach("share-management-desktop", {
      body: await page.screenshot({ animations: "disabled", fullPage: true }),
      contentType: "image/png",
    })
    await page.setViewportSize({ width: 375, height: 800 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    await test.info().attach("share-management-mobile", {
      body: await page.screenshot({ animations: "disabled", fullPage: true }),
      contentType: "image/png",
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole("button", { name: "Close share details", exact: true }).click()
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await page.getByRole("button", { name: "Copy link for Managed history", exact: true }).click()
    await expect(page.getByText("Link copied. Managed history", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(managed.share_url)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.reload()
    await page
      .getByRole("button", { name: "More actions for Managed history", exact: true })
      .click()
    await page.getByRole("menuitem", { name: "Show link", exact: true }).click()
    const link = page.getByRole("region", { name: "Public link: Managed history", exact: true })
    await expect(link.getByRole("textbox", { name: "Public share URL", exact: true })).toHaveValue(
      managed.share_url,
    )
    await link.getByRole("button", { name: "Hide link", exact: true }).click()
    await revokeShare(page, "Managed history")
    const removed = page.waitForResponse(
      (response) => response.url().endsWith(path) && response.request().method() === "DELETE",
    )
    await page.getByRole("button", { name: "Confirm revocation", exact: true }).click()
    expect((await removed).status()).toBe(204)
    await expect(
      page.getByRole("button", { name: "Revoke share Managed history", exact: true }),
    ).toHaveCount(0)
    const after = await page.request.get(path)
    expect((await after.json()).view_count).toBe(0)
    const token = new URL(managed.share_url).pathname.split("/").pop()
    const publicRead = await page.request.get(`/v1/shares/${token}`)
    expect(publicRead.status()).toBe(410)
    expect((await publicRead.json()).code).toBe("revoked")
    page.off("request", observe)
    await page.getByLabel("Share status", { exact: true }).selectOption("revoked")
    await expect(
      page.getByRole("link", { name: "Preview share Managed history", exact: true }),
    ).toBeVisible()
    await page.getByLabel("Share status", { exact: true }).selectOption("all")
  })

  await test.step("invitation enrolls an independent account and authenticator", async () => {
    const token = await command(accountCLI, ["-kind", "invite"])
    secondContext = await browser.newContext({ baseURL })
    secondPage = await secondContext.newPage()
    const secondCDP = await secondContext.newCDPSession(secondPage)
    await secondCDP.send("WebAuthn.enable")
    await authenticator(secondCDP)
    await secondPage.bringToFront()
    await secondPage.goto("/invite")
    await secondPage.getByLabel("Invitation token", { exact: true }).fill(token)
    await secondPage.getByLabel("Account name", { exact: true }).fill("Independent account B")
    await secondPage.getByLabel("Passkey name", { exact: true }).fill("Independent B passkey")
    await secondPage.getByRole("button", { name: "Create account", exact: true }).click()
    await expectSignedIn(secondPage)
    const state = await account(secondPage)
    accountB = state.account_id
    expect(accountB).not.toBe(accountA)
    expect(state.display_name).toBe("Independent account B")
    await noBrowserSecret(secondPage, token)
    await command(helper, ["assert-no-secret"], token)
    const replay = await secondPage.request.post("/v1/auth/invite/begin", {
      headers: { Origin: baseURL as string },
      data: { token, name: "Replay", display_name: "Forbidden duplicate" },
    })
    expect(replay.status() >= 400 && replay.status() < 500).toBe(true)
    secondKey = await createKey(secondPage, "B integration key")
    expect((await account(page)).account_id).toBe(accountA)
  })

  await test.step("two-account share lists, counts, links, and revocation stay isolated", async () => {
    const keyA2 = await createKey(page, "Same account second key")
    const clientA = new MorselClient({ baseUrl: baseURL as string, apiKey: recoveryKey.key })
    const clientA2 = new MorselClient({ baseUrl: baseURL as string, apiKey: keyA2.key })
    const clientB = new MorselClient({ baseUrl: baseURL as string, apiKey: secondKey.key })
    const shareA = await clientA.createShare({ content: "# Isolation A private", max_views: 10 })
    const shareA2 = await clientA2.createShare({ content: "# Isolation A second", max_views: 10 })
    const shareB = await clientB.createShare({ content: "# Isolation B private", max_views: 10 })
    const capability = new URL(shareB.share_url)
    const token = (capability.hash || capability.pathname).split("/").pop() as string
    const missingID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    for (const [owner, id, foreign, label] of [
      [page, accountA, shareB, "Isolation A"],
      [secondPage, accountB, shareA, "Isolation B"],
    ] as const) {
      for (const sort of ["newest", "oldest", "most_views", "least_views"]) {
        for (const status of ["all", "active", "revoked", "expired", "view_limit_exhausted"]) {
          const response = await owner.request.get(
            `/v1/account/shares?q=${encodeURIComponent(label)}&sort=${sort}&status=${status}&limit=1`,
          )
          expect(response.status()).toBe(200)
          expect(response.headers()["x-morsel-account-id"]).toBe(id)
          const result = await response.json()
          const expected = status === "all" || status === "active" ? (id === accountA ? 2 : 1) : 0
          expect(result.matching_count).toBe(expected)
          expect(result.items).toHaveLength(Math.min(expected, 1))
          expect(
            result.items.every((item: { label: string }) => item.label.startsWith(label)),
          ).toBe(true)
          if (expected > 1) {
            expect(result.next_cursor).toEqual(expect.any(String))
            expect(result.next_cursor.length).toBeGreaterThan(0)
            const next = await owner.request.get(
              `/v1/account/shares?q=${encodeURIComponent(label)}&sort=${sort}&status=${status}&limit=1&cursor=${encodeURIComponent(result.next_cursor)}`,
            )
            expect(next.status()).toBe(200)
            const nextBody = await next.json()
            expect(nextBody.matching_count).toBe(expected)
            expect(nextBody.items).toHaveLength(1)
            expect(nextBody.next_cursor).toBeUndefined()
            expect(new Set([result.items[0].id, nextBody.items[0].id])).toEqual(
              new Set([shareA.id, shareA2.id]),
            )
            const other = owner === page ? secondPage : page
            const foreignCursor = await other.request.get(
              `/v1/account/shares?q=${encodeURIComponent(label)}&sort=${sort}&status=${status}&limit=1&cursor=${encodeURIComponent(result.next_cursor)}`,
            )
            expect(foreignCursor.status()).toBe(400)
          } else expect(result.next_cursor).toBeUndefined()
        }
      }
      const empty = await owner.request.get(
        `/v1/account/shares?q=${encodeURIComponent(id === accountA ? "Isolation B" : "Isolation A")}`,
      )
      const emptyBody = await empty.json()
      expect(emptyBody.items).toEqual([])
      expect(emptyBody.matching_count).toBe(0)
      const state = await account(owner)
      const headers = { Origin: baseURL as string, "X-CSRF-Token": state.csrf_token }
      for (const suffix of ["", "/link"]) {
        const foreignRead = await owner.request.get(`/v1/account/shares/${foreign.id}${suffix}`)
        const missingRead = await owner.request.get(`/v1/account/shares/${missingID}${suffix}`)
        expect(foreignRead.status()).toBe(404)
        expect(missingRead.status()).toBe(404)
        expect(await foreignRead.json()).toEqual(await missingRead.json())
      }
      const foreignVerify = await owner.request.post(`/v1/account/shares/${foreign.id}/link`, {
        headers,
        data: { token },
      })
      const missingVerify = await owner.request.post(`/v1/account/shares/${missingID}/link`, {
        headers,
        data: { token },
      })
      expect(foreignVerify.status()).toBe(404)
      expect(missingVerify.status()).toBe(404)
      expect(await foreignVerify.json()).toEqual(await missingVerify.json())
      const foreignRevoke = await owner.request.delete(`/v1/account/shares/${foreign.id}`, {
        headers,
      })
      const missingRevoke = await owner.request.delete(`/v1/account/shares/${missingID}`, {
        headers,
      })
      expect(foreignRevoke.status()).toBe(404)
      expect(missingRevoke.status()).toBe(404)
      expect(await foreignRevoke.json()).toEqual(await missingRevoke.json())
    }
    for (const client of [clientA, clientA2]) {
      await expect(client.revokeShare(shareB.id)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      })
      await expect(client.revokeShare(missingID)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      })
    }
    await expect(clientB.revokeShare(shareA.id)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    })
    const ownedLink = await secondPage.request.get(`/v1/account/shares/${shareB.id}/link`)
    expect(ownedLink.status()).toBe(200)
    expect(ownedLink.headers()["x-morsel-account-id"]).toBe(accountB)
    expect((await ownedLink.json()).share_url).toBe(shareB.share_url)
    for (const [owner, id, share] of [
      [page, accountA, shareA],
      [secondPage, accountB, shareB],
    ] as const) {
      const detail = await owner.request.get(`/v1/account/shares/${share.id}`)
      expect(detail.status()).toBe(200)
      expect(detail.headers()["x-morsel-account-id"]).toBe(id)
      expect((await detail.json()).view_count).toBe(0)
    }
    const publicContext = await browser.newContext({ baseURL })
    try {
      const publicPage = await publicContext.newPage()
      expect((await account(publicPage)).authenticated).toBe(false)
      const read = await publicContext.request.get(`/v1/shares/${token}`)
      expect(read.status()).toBe(200)
      expect((await read.json()).content).toBe("# Isolation B private")
      expect(read.headers()["x-morsel-account-id"]).toBeUndefined()
    } finally {
      await publicContext.close()
    }
    // Account ownership does not depend on the key that created the share.
    await clientA2.revokeShare(shareA.id)
    await clientA.revokeShare(shareA2.id)
    const cliShare = await clientA.createShare({ content: "CLI same-account key interchange" })
    await command(
      "uv",
      [
        "run",
        "python",
        resolve("../../skills/morsel-share-markdown/scripts/revoke-share.py"),
        cliShare.id,
      ],
      undefined,
      {
        ...process.env,
        MORSEL_URL: baseURL,
        MORSEL_API_KEY: keyA2.key,
      },
    )
    await cliRevokeDenied(shareB.id, baseURL as string, keyA2.key)
    await cliRevokeDenied(missingID, baseURL as string, keyA2.key)
    await cliRevokeDenied(shareA.id, baseURL as string, secondKey.key)
  })

  await test.step("real cross-tab invalidation and response-bound cookie switch", async () => {
    const observer = await context.newPage()
    try {
      await observer.goto("/account")
      await expect(observer.getByText(accountA, { exact: true })).toBeVisible()
      await createKey(page, "Cross-tab one-time key")
      await expect(page.getByLabel("New API key", { exact: true })).toBeVisible()
      await logOut(observer)
      await expect(observer).toHaveURL(/\/login$/)
      await expect(
        observer.getByRole("button", { name: "Sign in with passkey", exact: true }),
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Sign in with passkey", exact: true }),
      ).toBeVisible()
      await expect(page.getByLabel("New API key", { exact: true })).toHaveCount(0)
      await login(page)
      await expect(observer.getByText("Account: Owner", { exact: true })).toBeVisible()
      expect((await account(observer)).account_id).toBe(accountA)

      await openSection(page, "Shares")
      await expect(
        page.getByRole("link", { name: "Preview share Legacy before account", exact: true }),
      ).toBeVisible()
      const aCookies = await context.cookies()
      const bCookies = await secondContext.cookies()
      let switched = false
      await page.route("**/v1/account/shares?*", async (route) => {
        if (!switched) {
          switched = true
          // Change the shared browser cookie only after the UI has selected A
          // and issued its private read. Authorization must now use B.
          await context.addCookies(bCookies)
          // Use the context's current cookie jar, not Chromium's intercepted
          // request headers. The response is still from the real backend.
          const response = await context.request.get(route.request().url())
          await route.fulfill({ response })
          return
        }
        await route.continue()
      })
      const authorized = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/v1/account/shares" &&
          response.headers()["x-morsel-account-id"] === accountB,
      )
      await page.getByRole("button", { name: "Refresh shares", exact: true }).click()
      expect((await authorized).status()).toBe(200)
      await expect(page.getByText("Account: Independent account B", { exact: true })).toBeVisible()
      expect((await account(page)).account_id).toBe(accountB)
      await expect(
        page.getByRole("link", { name: "Preview share Legacy before account", exact: true }),
      ).toHaveCount(0)
      await expect(
        page.getByRole("link", { name: "Preview share Isolation B private", exact: true }),
      ).toBeVisible()
      await page.unroute("**/v1/account/shares?*")
      await context.addCookies(aCookies)
      // Chromium headless does not reliably emit focus when bringToFront
      // changes tabs. Exercise the page's focus handler with the real cookie
      // jar and backend; the logout/login broadcast above uses actual tabs.
      await observer.bringToFront()
      await expect(observer.getByText("Account: Owner", { exact: true })).toBeVisible()
      await page.bringToFront()
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      await expect(page.getByText("Account: Owner", { exact: true })).toBeVisible()
      expect((await account(page)).account_id).toBe(accountA)
      await expect(
        page.getByRole("link", { name: "Preview share Isolation B private", exact: true }),
      ).toHaveCount(0)
      await expect(
        page.getByRole("link", { name: "Preview share Legacy before account", exact: true }),
      ).toBeVisible()
    } finally {
      await observer.close()
    }
  })

  await test.step("logout, discoverable login, and database session expiry", async () => {
    await logOut(page)
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    expect((await account(page)).authenticated).toBe(false)
    await login(page, "/manage/shares")
    await expect(page).toHaveURL(/\/manage\/shares$/)
    await page
      .getByRole("link", { name: "Preview share Legacy before account", exact: true })
      .click()
    await expect(
      page.getByRole("heading", { name: "Legacy before account", exact: true }),
    ).toBeVisible()
    await command(helper, ["expire-sessions", accountA])
    expect((await account(secondPage)).account_id).toBe(accountB)
    await page.getByRole("button", { name: "Close share details", exact: true }).click()
    await page.getByRole("button", { name: "Refresh shares", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Legacy before account", exact: true }),
    ).toHaveCount(0)
    await page.reload()
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    expect((await account(page)).authenticated).toBe(false)
    await login(page)
  })

  await test.step("all protected destinations return through dedicated login", async () => {
    for (const destination of ["/manage/shares", "/manage/api-keys", "/account"]) {
      await logOut(page)
      await expect(page).toHaveURL(/\/login$/)
      await page.goto(destination)
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(destination)}$`))
      await expect(page.getByRole("navigation", { name: "Management sections" })).toHaveCount(0)
      await page.reload()
      await page.getByRole("button", { name: "Sign in with passkey", exact: true }).click()
      await expectSignedIn(page)
      await expect(page).toHaveURL(new URL(destination, baseURL).href)
      await page.reload()
      await expectSignedIn(page)
    }
  })

  await test.step("cancelled browser authentication does not create an API key", async () => {
    await openSection(page, "API keys")
    await command(helper, ["expire-verification", accountA])
    await page.evaluate(() => {
      Object.defineProperty(navigator.credentials, "get", {
        configurable: true,
        value: () => Promise.reject(new DOMException("Cancelled", "NotAllowedError")),
      })
    })
    await page.getByLabel("API key name", { exact: true }).fill("Cancelled key")
    await page.getByRole("button", { name: "Create API key", exact: true }).click()
    await expect(page.getByRole("alert")).toHaveText(/.+/)
    const list = await page.request.get("/v1/api-keys")
    expect(JSON.stringify(await list.json()).includes("Cancelled key")).toBe(false)
    await page.reload()
  })

  await test.step("operator recovery replaces credentials and invalidates old sessions", async () => {
    const token = await command(accountCLI, ["-kind", "recover", "-account-id", accountA])
    const replacementContext = await browser.newContext({ baseURL })
    const replacementPage = await replacementContext.newPage()
    try {
      const replacementCDP = await replacementContext.newCDPSession(replacementPage)
      await replacementCDP.send("WebAuthn.enable")
      await authenticator(replacementCDP)
      await replacementPage.bringToFront()
      await replacementPage.goto(`${baseURL}/account`)
      await expect(replacementPage).toHaveURL(/\/login\?next=%2Faccount$/)
      await replacementPage.getByRole("link", { name: "Recover account", exact: true }).click()
      await expect(replacementPage).toHaveURL(/\/recover\?next=%2Faccount$/)
      await replacementPage.reload()
      await replacementPage.getByLabel("Recovery token", { exact: true }).fill(token)
      await replacementPage
        .getByLabel("Replacement passkey name", { exact: true })
        .fill("Replacement passkey")
      await replacementPage.getByRole("button", { name: "Recover account", exact: true }).click()
      await expectSignedIn(replacementPage)
      await expect(replacementPage).toHaveURL(/\/account$/)
      expect((await account(page)).authenticated).toBe(false)
      expect((await account(replacementPage)).account_id).toBe(accountA)
      expect((await account(secondPage)).account_id).toBe(accountB)
      const bKeys = await secondPage.request.get("/v1/api-keys")
      expect(bKeys.headers()["x-morsel-account-id"]).toBe(accountB)
      expect((await bKeys.json()).some((key: { id: string }) => key.id === secondKey.id)).toBe(true)
      const bClient = new MorselClient({ baseUrl: baseURL as string, apiKey: secondKey.key })
      const bShare = await bClient.createShare({ content: "B key survives A recovery" })
      await bClient.revokeShare(bShare.id)
      await test.step("B discoverable login remains usable after A recovery", async () => {
        await logOut(secondPage)
        await login(secondPage)
        expect((await account(secondPage)).account_id).toBe(accountB)
      })
      const remaining = await replacementPage.request.get("/v1/passkeys")
      const passkeys = await remaining.json()
      expect(passkeys.length).toBe(1)
      expect(passkeys[0].name).toBe("Replacement passkey")
      const replay = await replacementPage.request.post(`${baseURL}/v1/auth/recover/begin`, {
        headers: { Origin: baseURL as string },
        data: { token, name: "Replay" },
      })
      expect(replay.status() >= 400 && replay.status() < 500).toBe(true)
      await test.step("A removed passkey cannot sign in after recovery", async () => {
        await page.bringToFront()
        await page.reload()
        await page.getByRole("button", { name: "Sign in with passkey", exact: true }).click()
        await expect(page.getByRole("alert")).toHaveText(/.+/)
        expect((await account(page)).authenticated).toBe(false)
      })
      const client = new MorselClient({ baseUrl: baseURL as string, apiKey: recoveryKey.key })
      const share = await client.createShare({
        content: "Recovery preserves API keys for operator review",
      })
      await client.revokeShare(share.id)
      await test.step("A replacement passkey signs in after browser reload", async () => {
        await logOut(replacementPage)
        await login(replacementPage)
        await replacementPage.reload()
        await expectSignedIn(replacementPage)
      })
    } finally {
      await replacementContext.close()
      await secondContext.close()
    }
  })
})
