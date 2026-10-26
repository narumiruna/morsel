import { type BrowserContext, expect, type Page, type Request, test } from "@playwright/test"

const A = "10000000-0000-4000-8000-000000000001"
const B = "20000000-0000-4000-8000-000000000002"
const shareID = "30000000-0000-4000-8000-000000000003"
const created = "2026-10-26T00:00:00Z"
const foreignSecret = "FOREIGN-RESPONSE-MUST-NOT-RENDER"
const capability = `https://example.test/#/s/${"A".repeat(43)}`

async function mockAccounts(context: BrowserContext, baseURL: string) {
  await context.addCookies([{ name: "fixture-account", value: "A", url: baseURL }])
  let preflightRace: (() => Promise<void>) | undefined
  let pending: { path: string; resolve: () => void; promise: Promise<void> } | undefined
  const mutations: string[] = []
  const authorized: { path: string; id: string }[] = []
  const metadata = (id: string) => ({
    id: shareID,
    label: id === A ? "Alpha share" : "Beta share",
    created_at: created,
    expires_at: null,
    max_views: null,
    view_count: 0,
    revoked_at: null,
    status: "active",
    link_available: true,
  })
  await context.route("**/v1/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const id = /fixture-account=B(?:;|$)/.test(request.headers().cookie ?? "") ? B : A
    authorized.push({ path, id })
    const headers = { "X-Morsel-Account-ID": id }
    if (pending?.path === path) {
      const delayed = pending
      pending = undefined
      await delayed.promise
    }
    if (path === "/v1/account") {
      const changeCookie = preflightRace
      preflightRace = undefined
      await changeCookie?.()
      return route.fulfill({
        headers,
        json: {
          authenticated: true,
          setup_required: false,
          account_id: id,
          display_name: id === A ? "Alpha" : "Beta",
          csrf_token: `csrf-${id}`,
          verification_required: false,
        },
      })
    }
    if (path === "/v1/api-keys") {
      if (request.method() === "POST") {
        mutations.push(id)
        return route.fulfill({ headers, json: { id: "new-key", key: foreignSecret } })
      }
      return route.fulfill({
        headers,
        json: [
          {
            id: "cli",
            name: id === A ? "Alpha key" : "Beta key",
            prefix: "morsel_test",
            created_at: created,
            revoked_at: null,
          },
        ],
      })
    }
    if (path === "/v1/passkeys")
      return route.fulfill({
        headers,
        json: [
          { id: "first", name: id === A ? "Alpha passkey" : "Beta passkey", created_at: created },
        ],
      })
    if (path === "/v1/account/shares")
      return route.fulfill({ headers, json: { items: [metadata(id)], matching_count: 1 } })
    if (path.endsWith("/link")) return route.fulfill({ headers, json: { share_url: capability } })
    if (path.startsWith("/v1/account/shares/"))
      return route.fulfill({ headers, json: { ...metadata(id), content: `# ${foreignSecret}` } })
    throw new Error(`Unexpected request: ${request.method()} ${path}`)
  })
  return {
    mutations,
    authorized,
    race: (callback: () => Promise<void>) => {
      preflightRace = callback
    },
    hold: (path: string) => {
      let resolve!: () => void
      const promise = new Promise<void>((complete) => {
        resolve = complete
      })
      pending = { path, promise, resolve }
      return resolve
    },
  }
}
async function changeCookie(tab: Page) {
  await tab.evaluate(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: model a same-origin cookie change in another tab without an application event.
    document.cookie = "fixture-account=B; path=/; SameSite=Lax"
  })
}

test("a second-tab cookie switch between mutation preflight and authorization discards the key and never replays", async ({
  page,
  context,
  baseURL,
}) => {
  const backend = await mockAccounts(context, baseURL as string)
  const otherTab = await context.newPage()
  await otherTab.goto("/")
  await page.goto("/manage/api-keys")
  await expect(page.getByText(/Account: Alpha/)).toBeVisible()
  await page.getByLabel("API key name", { exact: true }).fill("CLI")
  backend.race(() => changeCookie(otherTab))
  await page.getByRole("button", { name: "Create API key", exact: true }).click()
  await expect(page.getByText(/Account: Beta/)).toBeVisible()
  await expect(page.getByLabel("New API key", { exact: true })).toHaveCount(0)
  await expect(page.getByText(foreignSecret, { exact: true })).toHaveCount(0)
  expect(backend.mutations).toEqual([B])
  await page.getByRole("link", { name: "Security", exact: true }).click()
  await expect(page.getByText("Beta passkey", { exact: true })).toBeVisible()
  expect(backend.mutations).toEqual([B])
})

test("a second-tab cookie switch invalidates a cached link before it can be copied again", async ({
  page,
  context,
  baseURL,
}) => {
  const backend = await mockAccounts(context, baseURL as string)
  const otherTab = await context.newPage()
  await otherTab.goto("/")
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/manage/shares")
  await page.getByRole("button", { name: "Copy link for Alpha share", exact: true }).click()
  await expect(page.getByText("Link copied. Alpha share", { exact: true })).toBeVisible()
  await page.evaluate(() => navigator.clipboard.writeText("clipboard-sentinel"))
  await changeCookie(otherTab)
  await page.getByRole("button", { name: "Copy link for Alpha share", exact: true }).click()
  await expect(page.getByText(/Account: Beta/)).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("clipboard-sentinel")
  expect(backend.authorized.filter(({ path }) => path.endsWith("/link"))).toHaveLength(1)
  await expect(
    page.getByRole("button", { name: "Copy link for Beta share", exact: true }),
  ).toBeVisible()
})

for (const kind of ["detail", "link", "passkeys", "key list"] as const) {
  test(`a delayed ${kind} response cannot restore private state after a cross-tab invalidation`, async ({
    page,
    context,
    baseURL,
  }) => {
    const backend = await mockAccounts(context, baseURL as string)
    const otherTab = await context.newPage()
    await otherTab.goto("/")
    const path =
      kind === "passkeys"
        ? "/v1/passkeys"
        : kind === "key list"
          ? "/v1/api-keys"
          : `/v1/account/shares/${shareID}${kind === "link" ? "/link" : ""}`
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === path)
    let release: () => void
    if (kind === "passkeys" || kind === "key list") {
      release = backend.hold(path)
      await page.goto(kind === "passkeys" ? "/account" : "/manage/api-keys")
    } else {
      await page.goto("/manage/shares")
      await expect(
        page.getByRole("link", { name: "Preview share Alpha share", exact: true }),
      ).toBeVisible()
      if (kind === "link") {
        await context.grantPermissions(["clipboard-read", "clipboard-write"])
        await page.bringToFront()
        await page.evaluate(() => navigator.clipboard.writeText("delayed-link-sentinel"))
      }
      release = backend.hold(path)
      if (kind === "detail")
        await page.getByRole("link", { name: "Preview share Alpha share", exact: true }).click()
      else
        await page.getByRole("button", { name: "Copy link for Alpha share", exact: true }).click()
    }
    const heldRequest = await requested
    const settled = new Promise<void>((resolve) => {
      const done = (request: Request) => {
        if (request !== heldRequest) return
        page.off("requestfinished", done)
        page.off("requestfailed", done)
        resolve()
      }
      page.on("requestfinished", done)
      page.on("requestfailed", done)
    })
    await expect
      .poll(() => backend.authorized.some((request) => request.path === path && request.id === A))
      .toBe(true)
    await changeCookie(otherTab)
    await otherTab.evaluate(() => {
      const channel = new BroadcastChannel("morsel:account-invalidation")
      channel.postMessage("invalidate")
      channel.close()
    })
    await expect(page.getByText(/Account: Beta/)).toBeVisible()
    release()
    await settled
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    if (kind === "link")
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "delayed-link-sentinel",
      )
    await expect(page.getByText(foreignSecret, { exact: true })).toHaveCount(0)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByLabel("Public share URL", { exact: true })).toHaveCount(0)
    await expect(page.getByText("Alpha passkey", { exact: true })).toHaveCount(0)
    await expect(page.getByText("Alpha key", { exact: true })).toHaveCount(0)
  })
}
