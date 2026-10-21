import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type CDPSession, expect, type Page, test } from "@playwright/test"
import { MorselClient } from "../../client/src/index"

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
  return response.json()
}

async function login(page: Page) {
  await page.goto("/account")
  const completion = page.waitForResponse((response) =>
    response.url().endsWith("/v1/auth/login/finish"),
  )
  await page.getByRole("button", { name: "Sign in with passkey", exact: true }).click()
  expect((await completion).status()).toBe(200)
  await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeVisible()
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
  await page.getByLabel("API key name", { exact: true }).fill(name)
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/v1/api-keys") && response.request().method() === "POST",
  )
  await page.getByRole("button", { name: "Create API key", exact: true }).click()
  const response = await created
  expect(response.status()).toBe(201)
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

  await test.step("operator setup, secure session, and closed registration", async () => {
    const token = await command(accountCLI, ["-kind", "setup"])
    expect(token.length >= 32).toBe(true)
    await page.goto("/account")
    expect((await account(page)).setup_required).toBe(true)
    await page.getByLabel("Setup token", { exact: true }).fill(token)
    await page.getByLabel("Passkey name", { exact: true }).fill("Primary browser passkey")
    await page.getByRole("button", { name: "Set up account", exact: true }).click()
    await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeVisible()
    const state = await account(page)
    expect(state.authenticated).toBe(true)
    expect(state.setup_required).toBe(false)
    const cookies = await context.cookies()
    expect(cookies.some((cookie) => cookie.httpOnly && cookie.sameSite === "Lax")).toBe(true)
    await noBrowserSecret(page, token)
    const rejected = await page.request.post("/v1/auth/setup/begin", {
      headers: { Origin: baseURL as string },
      data: { token, name: "Forbidden second owner" },
    })
    expect(rejected.status() >= 400 && rejected.status() < 500).toBe(true)
    await page.reload()
    await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeVisible()
  })

  await test.step("backup passkey enrollment and last-passkey protection", async () => {
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
    await page
      .getByRole("button", { name: "Remove passkey Primary browser passkey", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Remove passkey Primary browser passkey", exact: true }),
    ).toHaveCount(0)
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

  await test.step("logout, discoverable login, and database session expiry", async () => {
    await page.getByRole("button", { name: "Log out", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    expect((await account(page)).authenticated).toBe(false)
    await login(page)
    await command(helper, ["expire-sessions"])
    await page.reload()
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    expect((await account(page)).authenticated).toBe(false)
    await login(page)
  })

  await test.step("cancelled browser authentication does not create an API key", async () => {
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
    const token = await command(accountCLI, ["-kind", "recover"])
    const replacementContext = await browser.newContext({ baseURL })
    const replacementPage = await replacementContext.newPage()
    try {
      const replacementCDP = await replacementContext.newCDPSession(replacementPage)
      await replacementCDP.send("WebAuthn.enable")
      await authenticator(replacementCDP)
      await replacementPage.goto(`${baseURL}/account`)
      await replacementPage.getByLabel("Recovery token", { exact: true }).fill(token)
      await replacementPage
        .getByLabel("Replacement passkey name", { exact: true })
        .fill("Replacement passkey")
      await replacementPage.getByRole("button", { name: "Recover account", exact: true }).click()
      await expect(
        replacementPage.getByRole("button", { name: "Log out", exact: true }),
      ).toBeVisible()
      expect((await account(page)).authenticated).toBe(false)
      const remaining = await replacementPage.request.get("/v1/passkeys")
      const passkeys = await remaining.json()
      expect(passkeys.length).toBe(1)
      expect(passkeys[0].name).toBe("Replacement passkey")
      const replay = await replacementPage.request.post(`${baseURL}/v1/auth/recover/begin`, {
        headers: { Origin: baseURL as string },
        data: { token, name: "Replay" },
      })
      expect(replay.status() >= 400 && replay.status() < 500).toBe(true)
      await page.reload()
      await page.getByRole("button", { name: "Sign in with passkey", exact: true }).click()
      await expect(page.getByRole("alert")).toHaveText(/.+/)
      expect((await account(page)).authenticated).toBe(false)
      const client = new MorselClient({ baseUrl: baseURL as string, apiKey: recoveryKey.key })
      const share = await client.createShare({
        content: "Recovery preserves API keys for operator review",
      })
      await client.revokeShare(share.id)
      await replacementPage.getByRole("button", { name: "Log out", exact: true }).click()
      await login(replacementPage)
      await replacementPage.reload()
      await expect(
        replacementPage.getByRole("button", { name: "Log out", exact: true }),
      ).toBeVisible()
    } finally {
      await replacementContext.close()
    }
  })
})
