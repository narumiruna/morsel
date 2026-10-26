import { expect, type Page, type Request, test } from "@playwright/test"
import axe from "axe-core"

const A = "10000000-0000-4000-8000-000000000001"
const B = "20000000-0000-4000-8000-000000000002"
const token = "A".repeat(43)
const second = `${"B".repeat(42)}A`
const link = `https://morsel.example/invite#token=${token}`

async function mock(page: Page, authenticated = true) {
  const state = {
    authenticated,
    setup_required: false,
    account_id: A,
    display_name: "Alpha",
    role: "admin",
    csrf_token: "csrf",
    verification_required: false,
  }
  const posts: string[] = []
  let failure = false
  let expires = new Date(Date.now() + 3600000).toISOString()
  let held: { path: string; promise: Promise<void> } | undefined
  await page.route("**/v1/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const id = state.account_id
    if (request.method() === "POST") posts.push(path)
    const wait = held?.path === path ? held : undefined
    if (wait) {
      held = undefined
      await wait.promise
    }
    const headers = { "X-Morsel-Account-ID": id }
    if (path === "/v1/account")
      return route.fulfill({ headers, json: { ...state, account_id: id } })
    if (path === "/v1/account/invitations")
      return route.fulfill({
        headers,
        status: failure ? 503 : 201,
        json: failure
          ? { message: "Issuance unavailable. Try again." }
          : { invitation_url: link, expires_at: expires },
      })
    if (path === "/v1/passkeys" || path === "/v1/api-keys")
      return route.fulfill({ headers, json: [] })
    if (path === "/v1/account/shares")
      return route.fulfill({ headers, json: { items: [], matching_count: 0 } })
    throw new Error(`Unexpected request ${path}`)
  })
  return {
    state,
    posts,
    fail(value: boolean) {
      failure = value
    },
    expire() {
      expires = new Date(Date.now() - 1000).toISOString()
    },
    hold(path: string) {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      held = { path, promise }
      return release
    },
  }
}
function watchSettlement(page: Page, request: Request) {
  const done = new Promise<void>((resolve) => {
    const finish = (value: Request) => {
      if (value !== request) return
      page.off("requestfinished", finish)
      page.off("requestfailed", finish)
      resolve()
    }
    page.on("requestfinished", finish)
    page.on("requestfailed", finish)
  })
  return async (release: () => void) => {
    release()
    await done
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
  }
}

test("recipient fragments are scrubbed before shared navigation, never stored or posted on open, and never replayed by history", async ({
  page,
}) => {
  const backend = await mock(page, false)
  const requests: { url: string; referrer: string }[] = []
  page.on("request", (request) =>
    requests.push({ url: request.url(), referrer: request.headers().referer ?? "" }),
  )
  await page.addInitScript(() => {
    const recorded: string[] = []
    Object.assign(window, { secretAudit: recorded })
    for (const name of ["pushState", "replaceState"] as const) {
      const original = history[name].bind(history)
      history[name] = (state, unused, url) => {
        recorded.push(JSON.stringify({ state, url }))
        original(state, unused, url)
      }
    }
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      recorded.push(JSON.stringify({ key, value }))
      setItem.call(this, key, value)
    }
    window.addEventListener("morsel:navigate", (event) =>
      recorded.push(JSON.stringify((event as CustomEvent).detail)),
    )
  })
  await page.goto(`/invite#token=${token}`)
  await expect(page.getByLabel("Invitation token", { exact: true })).toHaveValue(token)
  await expect(page).toHaveURL(/\/invite$/)
  expect(backend.posts).toEqual([])
  await page.evaluate((value) => {
    window.location.hash = `token=${value}`
  }, second)
  await expect(page.getByLabel("Invitation token", { exact: true })).toHaveValue(second)
  await expect(page).toHaveURL(/\/invite$/)
  await page.goBack()
  await expect(page.getByLabel("Invitation token", { exact: true })).toHaveValue("")
  await page.goForward()
  await expect(page.getByLabel("Invitation token", { exact: true })).toHaveValue("")
  const beforeReload = await page.evaluate(() =>
    JSON.stringify((window as unknown as { secretAudit: string[] }).secretAudit),
  )
  expect(beforeReload).not.toContain(token)
  expect(beforeReload).not.toContain(second)
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([])
  await page.reload()
  await expect(page.getByLabel("Invitation token", { exact: true })).toHaveValue("")
  const audit = await page.evaluate(() =>
    JSON.stringify({
      state: history.state,
      storage: { ...localStorage, ...sessionStorage },
      audit: (window as unknown as { secretAudit: string[] }).secretAudit,
    }),
  )
  expect(audit).not.toContain(token)
  expect(audit).not.toContain(second)
  expect(JSON.stringify(requests)).not.toContain(token)
  expect(JSON.stringify(requests)).not.toContain(second)
  expect(backend.posts).toEqual([])
})

for (const [index, fragment] of [
  `token=${token}&token=${token}`,
  `token=${token}&unknown=x`,
  "token=%",
  `token=${"A".repeat(42)}B`,
  `token=%41${token.slice(1)}`,
  `token=${token}A`,
].entries()) {
  test(`rejects and scrubs malformed invitation fragment ${index}`, async ({ page }) => {
    const backend = await mock(page, false)
    await page.goto(`/invite#${fragment}`)
    await expect(page.getByLabel("Invitation token", { exact: true })).toHaveValue("")
    await expect(page).toHaveURL(/\/invite$/)
    expect(backend.posts).toEqual([])
  })
}

test("signed-in recipients get explicit instructions and no invitation survives expiration of that session", async ({
  page,
}) => {
  const backend = await mock(page)
  await page.goto(`/invite#token=${token}`)
  await expect(page.getByText(/use a private window/)).toBeVisible()
  await expect(page).toHaveURL(/\/invite$/)
  await expect(page.getByLabel("Invitation token", { exact: true })).toHaveCount(0)
  expect(backend.posts).toEqual([])
  backend.state.authenticated = false
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.getByLabel("Invitation token", { exact: true })).toHaveValue("")
  expect(backend.posts).toEqual([])
})

test("admin creates one link with explicit retry, manual-copy fallback, discard warning, and dismissal", async ({
  page,
  context,
}) => {
  const backend = await mock(page)
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/manage/invitations")
  await expect(page.getByRole("heading", { name: "Manage invitations", exact: true })).toBeVisible()
  expect(backend.posts).toEqual([])
  backend.fail(true)
  await page.getByRole("button", { name: "Create invitation link", exact: true }).click()
  await expect(page.getByText("Issuance unavailable. Try again.")).toBeVisible()
  expect(backend.posts).toHaveLength(1)
  backend.fail(false)
  await page.getByRole("button", { name: "Create invitation link", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toHaveValue(
    link,
  )
  expect(backend.posts).toHaveLength(2)
  await expect(
    page.getByRole("button", { name: "Create invitation link", exact: true }),
  ).toHaveCount(0)
  await page.evaluate(() => {
    Object.assign(window, { originalCopy: navigator.clipboard.writeText.bind(navigator.clipboard) })
    navigator.clipboard.writeText = async () => {
      throw new Error("denied")
    }
  })
  await page.getByRole("button", { name: "Copy link", exact: true }).click()
  await expect(page.getByText(/Could not copy link/)).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toBeFocused()
  await page.evaluate(() => {
    navigator.clipboard.writeText = (
      window as unknown as { originalCopy: typeof navigator.clipboard.writeText }
    ).originalCopy
  })
  await page.getByRole("button", { name: "Copy link", exact: true }).click()
  await expect(page.getByText("Invitation link copied.", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link)
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("link", { name: "Security", exact: true }).click()
  await expect(page).toHaveURL(/\/manage\/invitations$/)
  await page.getByRole("button", { name: "Dismiss invitation link", exact: true }).click()
  await page.getByRole("link", { name: "Security", exact: true }).click()
  await expect(page).toHaveURL(/\/account$/)
  expect(backend.posts).toHaveLength(2)
})

for (const roleLoss of [true, false]) {
  test(`delayed invitation response is discarded after ${roleLoss ? "same-account role loss" : "account switch"} with no replay or clipboard change`, async ({
    page,
    context,
  }) => {
    const backend = await mock(page)
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.goto("/manage/invitations")
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"))
    const release = backend.hold("/v1/account/invitations")
    const requested = page.waitForRequest("**/v1/account/invitations")
    await page.getByRole("button", { name: "Create invitation link", exact: true }).click()
    const finish = watchSettlement(page, await requested)
    backend.state.role = "user"
    if (!roleLoss) {
      backend.state.account_id = B
      backend.state.display_name = "Beta"
    }
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(page.getByText(/Access denied/)).toBeVisible()
    await finish(release)
    await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Invitations", exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("sentinel")
    expect(backend.posts).toEqual(["/v1/account/invitations"])
  })
}

test("a silent cookie identity change during copy preflight cannot change the clipboard after settlement", async ({
  page,
  context,
}) => {
  const backend = await mock(page)
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/manage/invitations")
  await page.getByRole("button", { name: "Create invitation link", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toHaveValue(
    link,
  )
  await page.evaluate(() => navigator.clipboard.writeText("copy-sentinel"))
  backend.state.account_id = B
  backend.state.display_name = "Beta"
  backend.state.role = "user"
  const release = backend.hold("/v1/account")
  const requested = page.waitForRequest("**/v1/account")
  await page.getByRole("button", { name: "Copy link", exact: true }).click()
  const finish = watchSettlement(page, await requested)
  await finish(release)
  await expect(page.getByText(/Access denied/)).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("copy-sentinel")
  await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toHaveCount(0)
  expect(backend.posts).toEqual(["/v1/account/invitations"])
})

for (const width of [320, 375, 1280]) {
  test(`admin invitation controls are keyboard accessible without overflow at ${width}px`, async ({
    page,
  }) => {
    const backend = await mock(page)
    await page.setViewportSize({ width, height: 800 })
    await page.goto("/manage/invitations")
    const create = page.getByRole("button", { name: "Create invitation link", exact: true })
    await create.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.getByRole("button", { name: "Copy link", exact: true })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(
      page.getByRole("button", { name: "Dismiss invitation link", exact: true }),
    ).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )
    await page.evaluate(axe.source)
    const violations = await page.evaluate(async () => {
      const browserAxe = (window as unknown as { axe: typeof axe }).axe
      const result = await browserAxe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
      return result.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => node.target),
      }))
    })
    expect(violations).toEqual([])
    await page.keyboard.press("Enter")
    await expect(create).toBeVisible()
    expect(backend.posts).toEqual(["/v1/account/invitations"])
  })
}

test("same-account role loss clears a displayed link and expired links cannot be copied", async ({
  page,
}) => {
  const backend = await mock(page)
  backend.expire()
  await page.goto("/manage/invitations")
  await page.getByRole("button", { name: "Create invitation link", exact: true }).click()
  await expect(page.getByText(/invitation link has expired/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Copy link", exact: true })).toBeDisabled()
  backend.state.role = "user"
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.getByText(/Access denied/)).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Invitation link", exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Invitations", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText(/Access denied/)).toBeVisible()
  expect(backend.posts).toHaveLength(1)
})
