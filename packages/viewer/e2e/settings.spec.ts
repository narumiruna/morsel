import { expect, type Page, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/account", (route) =>
    route.fulfill({ json: { authenticated: false, setup_required: false } }),
  )
})

const token = "P".repeat(43)
const otherToken = "Q".repeat(43)
const content = `# Settings fixture

\`\`\`mermaid
flowchart LR
  A[Browser] --> B[Reader]
\`\`\``
const chart = `\`\`\`vega-lite
{
  "data": {"values": [{"label": "A", "value": 1}, {"label": "B", "value": 2}]},
  "mark": "bar",
  "encoding": {
    "x": {"field": "label", "type": "nominal"},
    "y": {"field": "value", "type": "quantitative"}
  }
}
\`\`\``
const share = {
  content,
  created_at: "2026-01-01T00:00:00Z",
  view_count: 1,
  views_remaining: 4,
}

async function mockShare(page: Page, shareToken = token, markdown = content) {
  await page.route(`**/v1/shares/${shareToken}`, (route) =>
    route.fulfill({ json: { ...share, content: markdown } }),
  )
}

async function openSettings(page: Page) {
  const link = page.getByRole("banner").getByRole("link", { name: "Settings", exact: true })
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible()
}

async function selectPreference(page: Page, name: "Theme" | "Mermaid style", value: string) {
  const preference = page.getByRole("combobox", { name, exact: true })
  await preference.click()
  await page.getByRole("option", { name: value, exact: true }).click()
  await expect(preference).toHaveText(value)
}

test("loads and reloads guest preferences with only an account identity request", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: "light" })
  const apiRequests: string[] = []
  let releaseIdentity!: () => void
  const identityReady = new Promise<void>((resolve) => {
    releaseIdentity = resolve
  })
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    apiRequests.push(path)
    if (path === "/v1/account") {
      expect(route.request().method()).toBe("GET")
      await identityReady
      return route.fulfill({ json: { authenticated: false, setup_required: false } })
    }
    return route.fulfill({
      status: 401,
      json: { code: "unauthorized", message: "Authentication required" },
    })
  })

  await page.goto("/settings")
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Themes", level: 2 })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Mermaid styles", level: 2 })).toBeVisible()
  const header = page.getByRole("banner")
  await expect(header.getByRole("link", { name: "Settings", exact: true })).toBeVisible()
  await expect(header.getByRole("combobox")).toHaveCount(0)
  await expect(header.getByRole("button", { name: "Account", exact: true })).toHaveCount(0)

  const theme = page.getByRole("combobox", { name: "Theme", exact: true })
  const style = page.getByRole("combobox", { name: "Mermaid style", exact: true })
  await expect(theme).toHaveText("System")
  await expect(style).toHaveText("Source style")
  await theme.click()
  await expect(page.getByRole("option")).toHaveText([
    "System",
    "Light",
    "Sepia",
    "Sage",
    "Dark",
    "Midnight",
  ])
  await page.keyboard.press("Escape")
  await style.click()
  await expect(page.getByRole("option")).toHaveText(["Source style", "Classic", "Hand-drawn"])
  await page.keyboard.press("Escape")
  await testInfo.attach("settings-desktop", {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  })

  await expect.poll(() => apiRequests).toContain("/v1/account")
  await selectPreference(page, "Theme", "Sepia")
  await selectPreference(page, "Mermaid style", "Hand-drawn")
  await expect(page.locator(".morsel-theme")).toHaveAttribute("data-theme-mode", "sepia")
  const identity = page.waitForResponse("**/v1/account")
  releaseIdentity()
  expect((await identity).status()).toBe(200)
  await expect(page).toHaveURL(/\/settings$/)
  await expect(header.getByRole("button", { name: "Account", exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Invitations", exact: true })).toHaveCount(0)

  await page.reload()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible()
  await expect(theme).toHaveText("Sepia")
  await expect(style).toHaveText("Hand-drawn")
  await selectPreference(page, "Theme", "System")
  await selectPreference(page, "Mermaid style", "Source style")
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator(".morsel-theme")).toHaveAttribute("data-appearance", "dark")
  await page.reload()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(theme).toHaveText("System")
  await expect(style).toHaveText("Source style")
  await expect(page.locator(".morsel-theme")).toHaveAttribute("data-appearance", "dark")
  expect([...new Set(apiRequests)]).toEqual(["/v1/account"])
})

test("keeps preferences usable on Settings when the identity check is offline", async ({
  page,
}) => {
  const apiRequests: string[] = []
  await page.route("**/v1/**", (route) => {
    apiRequests.push(new URL(route.request().url()).pathname)
    return route.abort("internetdisconnected")
  })
  await page.goto("/settings")
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible()
  await expect.poll(() => apiRequests).toContain("/v1/account")
  await selectPreference(page, "Theme", "Sage")
  await selectPreference(page, "Mermaid style", "Classic")
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Account", exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Invitations", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("combobox", { name: "Theme", exact: true })).toHaveText("Sage")
  await expect(page.getByRole("combobox", { name: "Mermaid style", exact: true })).toHaveText(
    "Classic",
  )
  await expect(page).toHaveURL(/\/settings$/)
  expect([...new Set(apiRequests)]).toEqual(["/v1/account"])
})

test("persists global preferences across documents, routes, and reloads", async ({ page }) => {
  await mockShare(page)
  await mockShare(page, otherToken)
  await page.goto(`/s/${token}`)
  const diagram = page.locator(".mermaid-diagram")
  const themeRoot = page.locator(".morsel-theme")
  await expect(diagram).toBeVisible()

  await openSettings(page)
  await selectPreference(page, "Theme", "Sepia")
  await selectPreference(page, "Mermaid style", "Hand-drawn")
  expect(
    await page.evaluate(() => ({
      theme: localStorage.getItem("morsel-theme"),
      look: localStorage.getItem("morsel-mermaid-look"),
    })),
  ).toEqual({ theme: "sepia", look: "handDrawn" })
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/s/${token}$`))
  await expect(themeRoot).toHaveAttribute("data-theme-mode", "sepia")
  await expect(diagram.locator(".rough-node")).toHaveCount(2)

  await page.reload()
  await expect(themeRoot).toHaveAttribute("data-theme-mode", "sepia")
  await expect(diagram.locator(".rough-node")).toHaveCount(2)
  await page.goto(`/s/${otherToken}`)
  await expect(themeRoot).toHaveAttribute("data-theme-mode", "sepia")
  await expect(diagram.locator(".rough-node")).toHaveCount(2)

  await openSettings(page)
  await expect(page.getByRole("combobox", { name: "Theme", exact: true })).toHaveText("Sepia")
  await expect(page.getByRole("combobox", { name: "Mermaid style" })).toHaveText("Hand-drawn")
  await page.reload()
  await expect(page.getByRole("combobox", { name: "Theme", exact: true })).toHaveText("Sepia")
  await expect(page.getByRole("combobox", { name: "Mermaid style" })).toHaveText("Hand-drawn")
  await selectPreference(page, "Theme", "System")
  await selectPreference(page, "Mermaid style", "Source style")
  expect(await page.evaluate(() => localStorage.getItem("morsel-theme"))).toBe("system")
  expect(await page.evaluate(() => localStorage.getItem("morsel-mermaid-look"))).toBeNull()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/s/${otherToken}$`))
  await expect(themeRoot).toHaveAttribute("data-theme-mode", "system")
  await expect(diagram).toBeVisible()
  await expect(diagram.locator(".rough-node")).toHaveCount(0)
})

test("keeps Settings and preference menus within a mobile viewport", async ({ page }, testInfo) => {
  const width = 375
  await page.setViewportSize({ width, height: 800 })
  await mockShare(page)
  await page.goto(`/s/${token}`)
  await expect(page.getByRole("heading", { name: "Settings fixture" })).toBeVisible()
  const settings = page.getByRole("banner").getByRole("link", { name: "Settings", exact: true })
  await expect(settings).toBeVisible()
  await settings.focus()
  await settings.press("Enter")
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible()

  for (const [name, value] of [
    ["Theme", "Sage"],
    ["Mermaid style", "Hand-drawn"],
  ] as const) {
    const preference = page.getByRole("combobox", { name, exact: true })
    await expect(preference).toBeVisible()
    const trigger = await preference.boundingBox()
    if (!trigger) throw new Error(`${name} trigger missing`)
    expect(trigger.x).toBeGreaterThanOrEqual(0)
    expect(trigger.x + trigger.width).toBeLessThanOrEqual(width)
    await preference.click()
    const menu = page.getByRole("listbox")
    await expect(menu).toBeVisible()
    const menuBox = await menu.boundingBox()
    if (!menuBox) throw new Error(`${name} menu missing`)
    expect(menuBox.x).toBeGreaterThanOrEqual(0)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width)
    await page.getByRole("option", { name: value, exact: true }).click()
    await expect(preference).toHaveText(value)
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
  await testInfo.attach("settings-mobile", {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  })

  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/s/${token}$`))
  await expect(page.locator(".morsel-theme")).toHaveAttribute("data-theme-mode", "sage")
  await expect(page.locator(".mermaid-diagram .rough-node")).toHaveCount(2)
  await expect(settings).toBeVisible()
  await page.goForward()
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Theme", exact: true })).toHaveText("Sage")
  await expect(page.getByRole("combobox", { name: "Mermaid style" })).toHaveText("Hand-drawn")
})

for (const width of [1280, 375]) {
  test(`keeps Mermaid and Vega-Lite toolbars square without selectors at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await mockShare(page, token, `${content}\n\n${chart}`)
    await page.goto(`/s/${token}`)
    await expect(page.locator(".diagram-card")).toHaveCount(2)
    await openSettings(page)
    await selectPreference(page, "Theme", "Midnight")
    await selectPreference(page, "Mermaid style", "Hand-drawn")
    await page.goBack()
    await expect(page.locator(".diagram-card")).toHaveCount(2)
    await expect(page.locator(".mermaid-diagram .rough-node")).toHaveCount(2)
    await expect(page.locator(".vega-lite-chart svg")).toBeVisible()
    await expect(page.getByRole("combobox")).toHaveCount(0)
    await expect(page.locator(".morsel-theme")).toHaveAttribute("data-appearance", "dark")

    const actions = [
      "Zoom out",
      "Zoom in",
      "Fit to screen",
      "Reset zoom",
      "Fullscreen",
      "Show source",
      "Copy source",
      "Download SVG",
      "Download PNG",
    ]
    for (const card of await page.locator(".diagram-card").all()) {
      await expect(card).toHaveAttribute("aria-busy", "false")
      const controls = card.getByRole("group", { name: "Diagram controls" })
      await expect(controls.getByRole("button")).toHaveCount(actions.length)
      await expect(controls.locator("select, [role='combobox']")).toHaveCount(0)
      expect(
        await controls
          .getByRole("button")
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
      ).toEqual(actions)
    }
    const sizes = await page.locator(".diagram-controls button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect()
        return { height: bounds.height, width: bounds.width }
      }),
    )
    expect(
      sizes.every(
        (size) => size.height >= 44 && size.width >= 44 && Math.abs(size.height - size.width) <= 1,
      ),
    ).toBe(true)
    expect(new Set(sizes.map((size) => size.width)).size).toBe(1)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
  })
}

for (const routeKind of ["path", "hash"] as const) {
  test(`does not consume another ${routeKind} share view through Settings and Back`, async ({
    page,
  }) => {
    let reads = 0
    await page.route(`**/v1/shares/${token}`, (route) => {
      reads += 1
      return reads === 1
        ? route.fulfill({ json: { ...share, views_remaining: 0 } })
        : route.fulfill({
            status: 410,
            json: { code: "view_limit_exhausted", message: "No views remaining" },
          })
    })
    const navigations: string[] = []
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigations.push(request.url())
      }
    })
    await page.goto(routeKind === "path" ? `/s/${token}` : `/#/s/${token}`)
    const documentURL = page.url()
    await expect(page.getByRole("heading", { name: "Settings fixture" })).toBeVisible()
    await expect(page.getByText("View 1", { exact: true })).toBeVisible()
    await expect(page.getByText("0 remaining", { exact: true })).toBeVisible()
    expect(reads).toBe(1)

    await openSettings(page)
    await selectPreference(page, "Theme", "Dark")
    await selectPreference(page, "Mermaid style", "Hand-drawn")
    await page.goBack()
    await expect(page).toHaveURL(documentURL)
    await expect(page.getByRole("heading", { name: "Settings fixture" })).toBeVisible()
    await expect(page.locator(".mermaid-diagram .rough-node")).toHaveCount(2)
    await expect(page.getByText("View 1", { exact: true })).toBeVisible()
    await expect(page.getByText("0 remaining", { exact: true })).toBeVisible()
    await page.goForward()
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole("heading", { name: "Settings fixture" })).toBeVisible()
    expect(reads).toBe(1)
    expect(navigations).toHaveLength(1)
  })
}
