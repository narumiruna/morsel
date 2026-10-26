import { expect, type Page, test } from "@playwright/test"
import axe from "axe-core"

const token = "A".repeat(43)
const created = "2026-10-22T09:41:00Z"
const longTitle = "長".repeat(80)
const themes = ["light", "dark", "sepia", "sage", "midnight", "system"] as const

async function revokeShare(page: Page, label: string) {
  await page.getByRole("button", { name: `More actions for ${label}`, exact: true }).click()
  await page.getByRole("menuitem", { name: `Revoke share ${label}`, exact: true }).click()
  await expect(
    page.getByRole("heading", { name: `Revoke share ${label}?`, exact: true }),
  ).toBeFocused()
}

async function mockManagement(page: Page, backupPasskey = false) {
  let authenticated = true
  let reads = 0
  let creations = 0
  let failedList: "api-keys" | "passkeys" | null = null
  const mutations: string[] = []
  const passkeys = [
    { id: "fixture-passkey", name: "Laptop", created_at: created },
    ...(backupPasskey ? [{ id: "backup-passkey", name: "Phone", created_at: created }] : []),
  ]
  const keys = [
    {
      id: "fixture-key",
      name: "Build agent",
      prefix: "fixture-prefix",
      created_at: created,
      revoked_at: null as string | null,
    },
  ]
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    label: index === 7 ? longTitle : `Project note ${String(index + 1).padStart(2, "0")}`,
    created_at: new Date(Date.parse(created) + index * 60_000).toISOString(),
    expires_at: null,
    max_views: null,
    view_count: index,
    revoked_at: null as string | null,
    status: "active",
    link_available: true,
  }))
  const requests: string[] = []
  await page.route("**/v1/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    requests.push(path)
    if (path.startsWith("/v1/shares")) {
      reads += 1
      await route.fulfill({
        json: { content: "# Reader document", created_at: created, view_count: reads },
      })
      return
    }
    if (path === "/v1/account") {
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        json: {
          authenticated,
          account_id: "10000000-0000-4000-8000-000000000001",
          display_name: "Owner",
          setup_required: false,
          csrf_token: "fixture-csrf",
          verification_required: false,
        },
      })
      return
    }
    if (!authenticated) {
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        status: 401,
        json: { code: "session_expired" },
      })
      return
    }
    if (path === `/v1/${failedList}` && request.method() === "GET") {
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        status: 503,
        json: { message: "Fixture list unavailable." },
      })
    } else if (path === "/v1/passkeys") {
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        json: passkeys,
      })
    } else if (path.startsWith("/v1/passkeys/") && request.method() === "DELETE") {
      mutations.push(path)
      passkeys.splice(
        passkeys.findIndex((passkey) => path.endsWith(passkey.id)),
        1,
      )
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        status: 204,
      })
    } else if (path === "/v1/api-keys" && request.method() === "POST") {
      creations += 1
      const key = {
        id: `new-fixture-key-${creations}`,
        name: String(request.postDataJSON().name),
        prefix: `fixture-prefix-${creations}`,
        created_at: created,
        revoked_at: null,
      }
      keys.push(key)
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        status: 201,
        json: { ...key, key: "one-time-fixture-value-not-a-real-api-key" },
      })
    } else if (path === "/v1/api-keys") {
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        json: keys,
      })
    } else if (path === "/v1/account/shares") {
      const status = url.searchParams.get("status") ?? "all"
      const query = (url.searchParams.get("q") ?? "").toLowerCase()
      const matching = items.filter(
        (item) =>
          (status === "all" || item.status === status) && item.label.toLowerCase().includes(query),
      )
      matching.sort((left, right) =>
        url.searchParams.get("sort") === "oldest"
          ? left.created_at.localeCompare(right.created_at)
          : right.created_at.localeCompare(left.created_at),
      )
      const offset = url.searchParams.has("cursor") ? 25 : 0
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        json: {
          items: matching.slice(offset, offset + 25),
          matching_count: matching.length,
          ...(offset + 25 < matching.length ? { next_cursor: "fixture-next" } : {}),
        },
      })
    } else if (path.endsWith("/link") && request.method() === "GET") {
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        json: { share_url: `${url.origin}/#/s/${token}` },
      })
    } else if (path.startsWith("/v1/account/shares/")) {
      const item = items.find((candidate) => path.endsWith(candidate.id))
      if (!item)
        return route.fulfill({
          headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
          status: 404,
          json: { code: "not_found" },
        })
      if (request.method() === "DELETE") {
        mutations.push(path)
        item.revoked_at = created
        item.status = "revoked"
        await route.fulfill({
          headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
          status: 204,
        })
      } else {
        await route.fulfill({
          headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
          json: {
            ...item,
            content: `# Preview content\n\n![not fetched](/v1/shares/${token})\n\n\`\`\`mermaid\nflowchart TD\nA@{ img: "/v1/shares/${token}", label: "test", h: 60 }\n\`\`\``,
          },
        })
      }
    } else if (path.startsWith("/v1/api-keys/") && request.method() === "DELETE") {
      mutations.push(path)
      const key = keys.find((key) => path.endsWith(key.id))
      if (key) key.revoked_at = created
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        status: 204,
      })
    } else if (path === "/v1/auth/logout") {
      authenticated = false
      await route.fulfill({
        headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
        status: 204,
      })
    } else {
      throw new Error(`Unexpected fixture request: ${request.method()} ${path}`)
    }
  })
  return {
    reads: () => reads,
    creations: () => creations,
    failList: (value: typeof failedList) => {
      failedList = value
    },
    requests,
    mutations,
  }
}

async function checkControlContrast(page: Page) {
  const measurements = await page.evaluate(() => {
    type Color = [number, number, number, number]
    const color = (value: string): Color => {
      const values = value.match(/[\d.]+/g)?.map(Number) ?? []
      const scale = value.startsWith("color(srgb") ? 255 : 1
      return [
        (values[0] ?? 0) * scale,
        (values[1] ?? 0) * scale,
        (values[2] ?? 0) * scale,
        values[3] ?? 1,
      ]
    }
    const blend = (front: Color, back: Color): Color => [
      front[0] * front[3] + back[0] * (1 - front[3]),
      front[1] * front[3] + back[1] * (1 - front[3]),
      front[2] * front[3] + back[2] * (1 - front[3]),
      1,
    ]
    const background = (element: Element | null): Color => {
      const layers: Color[] = []
      for (let node = element; node; node = node.parentElement)
        layers.unshift(color(getComputedStyle(node).backgroundColor))
      return layers.reduce((back, front) => blend(front, back), [255, 255, 255, 1] as Color)
    }
    const luminance = (rgb: Color) => {
      const channels = rgb.slice(0, 3).map((value) => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
    }
    const contrast = (left: Color, right: Color) => {
      const a = luminance(left),
        b = luminance(right)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    const controls = [
      ...document.querySelectorAll<HTMLElement>("input:not(:disabled), select:not(:disabled)"),
    ]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => {
        const style = getComputedStyle(element)
        const inside = background(element),
          outside = background(element.parentElement)
        return {
          id: element.id,
          contrast: Math.min(
            contrast(blend(color(style.borderTopColor), inside), inside),
            contrast(blend(color(style.borderTopColor), outside), outside),
          ),
        }
      })
    const active = document.activeElement
    const style = active ? getComputedStyle(active) : null
    const outside = background(active?.parentElement ?? null)
    return {
      controls,
      outline: style
        ? {
            width: Number.parseFloat(style.outlineWidth),
            contrast: contrast(blend(color(style.outlineColor), outside), outside),
          }
        : null,
    }
  })
  for (const control of measurements.controls)
    expect(control.contrast, `Control boundary ${control.id}`).toBeGreaterThanOrEqual(3)
  expect(measurements.outline?.width).toBeGreaterThanOrEqual(2)
  expect(measurements.outline?.contrast).toBeGreaterThanOrEqual(3)
}

async function checkAxe(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  // Inspect the final colors, not a partially transparent dialog/menu transition.
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    )
  })
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
}

for (const width of [1280, 375]) {
  for (const theme of themes) {
    test(`compact management is accessible at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 })
      await page.addInitScript((mode) => localStorage.setItem("morsel-theme", mode), theme)
      const api = await mockManagement(page)
      await page.goto("/manage/shares")
      await expect(
        page.getByRole("link", { name: "Preview share Project note 30", exact: true }),
      ).toBeVisible()
      expect(api.requests).not.toContain("/v1/api-keys")
      expect(api.requests).not.toContain("/v1/passkeys")
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      )
      if (width === 375) {
        const first = await page.locator(".share-table tbody tr").first().boundingBox()
        expect(first?.y).toBeLessThanOrEqual(450)
      }
      if (width === 1280) {
        const fifth = await page
          .getByRole("link", { name: "Preview share Project note 26", exact: true })
          .boundingBox()
        expect(fifth).not.toBeNull()
        expect((fifth?.y ?? 801) + (fifth?.height ?? 0)).toBeLessThanOrEqual(800)
        await expect(page.getByRole("table")).toBeVisible()
        const titleWidth = await page
          .locator(".share-table .share-title")
          .first()
          .evaluate(
            (element) =>
              element.getBoundingClientRect().width /
              (element.closest("table")?.getBoundingClientRect().width ?? 1),
          )
        expect(titleWidth).toBeGreaterThanOrEqual(0.55)
        expect(titleWidth).toBeLessThanOrEqual(0.6)
      }
      await page.getByLabel("Search shares", { exact: true }).focus()
      await page.keyboard.press("Tab")
      await checkControlContrast(page)
      await checkAxe(page)
      const path = testInfo.outputPath(`task-ui-${width}-${theme}.png`)
      await page.screenshot({ path, fullPage: true, animations: "disabled" })
      await testInfo.attach(`task-ui-${width}-${theme}`, { path, contentType: "image/png" })
      await page.getByText("About share management", { exact: true }).click()
      await checkAxe(page)
      await page.getByRole("link", { name: "Preview share Project note 30", exact: true }).click()
      await expect(
        page.getByRole("heading", { name: "Preview content", exact: true }),
      ).toBeVisible()
      await checkAxe(page)
      if (width === 375) {
        const source = page.locator(".share-admin-detail pre").first()
        await source.focus()
        await page.keyboard.press("ArrowRight")
        await expect.poll(() => source.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
      }
      await page.getByRole("button", { name: "Close share details", exact: true }).click()
      await page
        .getByRole("button", { name: "More actions for Project note 30", exact: true })
        .click()
      await page.getByRole("menuitem", { name: "Show link", exact: true }).click()
      await expect(
        page
          .getByRole("region", { name: "Public link: Project note 30", exact: true })
          .getByRole("textbox"),
      ).toBeFocused()
      await checkAxe(page)
      await page.keyboard.press("Escape")
      await revokeShare(page, "Project note 30")
      await checkAxe(page)
      await page.getByRole("button", { name: "Cancel revocation", exact: true }).click()
      await page.getByRole("link", { name: "Morsel home", exact: true }).click()
      await page.getByLabel("Document URL", { exact: true }).focus()
      await page.keyboard.press("Tab")
      await checkControlContrast(page)
      await checkAxe(page)
      const homePath = testInfo.outputPath(`home-${width}-${theme}.png`)
      await page.screenshot({ path: homePath, fullPage: true, animations: "disabled" })
      await testInfo.attach(`home-${width}-${theme}`, { path: homePath, contentType: "image/png" })
      await page.getByRole("link", { name: "Manage", exact: true }).click()
      await page.getByRole("link", { name: "API keys", exact: true }).click()
      await page.getByLabel("API key name", { exact: true }).fill("Contrast fixture")
      await page.keyboard.press("Tab")
      await checkControlContrast(page)
      await checkAxe(page)
      await page.getByRole("button", { name: "Revoke API key Build agent", exact: true }).click()
      await checkAxe(page)
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.getByRole("link", { name: "Security", exact: true }).click()
      await expect(
        page.getByRole("button", { name: "Remove passkey Laptop", exact: true }),
      ).toBeDisabled()
      await checkAxe(page)
    })
  }
}

test("search, ordering, pagination, copy feedback, preview and confirmation remain task-specific", async ({
  page,
}) => {
  const api = await mockManagement(page)
  await page.goto("/manage/shares")
  await expect(page.locator(".share-page-summary")).toContainText("30 matching shares")
  await page.getByLabel("Share order", { exact: true }).selectOption("oldest")
  await expect(
    page.getByRole("link", { name: "Preview share Project note 01", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Previous shares", exact: true })).toBeDisabled()
  await page.getByLabel("Share order", { exact: true }).selectOption("newest")
  await expect(
    page.getByRole("link", { name: "Preview share Project note 30", exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Next shares", exact: true }).click()
  await expect(
    page.getByRole("link", { name: "Preview share Project note 01", exact: true }),
  ).toBeVisible()
  await page.getByLabel("Search shares", { exact: true }).fill("Project note 30")
  await page.getByRole("button", { name: "Search shares", exact: true }).click()
  await expect(page.getByRole("button", { name: "Previous shares", exact: true })).toBeDisabled()
  await expect(
    page.getByRole("link", { name: "Preview share Project note 30", exact: true }),
  ).toBeVisible()
  await page.getByRole("link", { name: "Preview share Project note 30", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Preview content", exact: true })).toBeVisible()
  expect(api.reads()).toBe(0)
  await expect(page.locator(".share-admin-detail img")).toHaveCount(0)
  await expect(page.locator(".share-admin-detail pre > code.language-mermaid")).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied")
        },
      },
    })
  })
  await page.getByRole("button", { name: "Copy share ID", exact: true }).click()
  await expect(page.getByText(/(could not|failed|unable).*cop/i)).toBeVisible()
  await page.getByRole("button", { name: "Close share details", exact: true }).click()
  await revokeShare(page, "Project note 30")
  await page.getByRole("button", { name: "Cancel revocation", exact: true }).click()
  expect(api.mutations).toHaveLength(0)
  await revokeShare(page, "Project note 30")
  await page.getByRole("button", { name: "Confirm revocation", exact: true }).click()
  await expect.poll(() => api.mutations.length).toBe(1)
  await page.getByRole("link", { name: "API keys", exact: true }).click()
  await page.getByRole("button", { name: "Revoke API key Build agent", exact: true }).click()
  await expect(page.getByText(/integrations/i)).toBeVisible()
  expect(api.mutations).toHaveLength(1)
})

for (const width of [1280, 375, 320]) {
  test(`preview keeps list position and contains keyboard focus at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 })
    const api = await mockManagement(page)
    await page.goto("/manage/shares")
    const trigger = page.getByRole("link", { name: "Preview share Project note 30", exact: true })
    await trigger.focus()
    const scroll = await page.evaluate(() => window.scrollY)
    await page.keyboard.press("Enter")
    const dialog = page.getByRole("dialog", { name: "Share details: Project note 30", exact: true })
    await expect(
      dialog.getByRole("heading", { name: "Preview content", exact: true }),
    ).toBeInViewport()
    await expect(
      dialog.getByRole("heading", { name: "Share details: Project note 30", exact: true }),
    ).toBeFocused()
    expect(await page.evaluate(() => window.scrollY)).toBe(scroll)
    const bounds = await dialog.boundingBox()
    expect(bounds?.y).toBeGreaterThanOrEqual(0)
    expect((bounds?.y ?? 800) + (bounds?.height ?? 1)).toBeLessThanOrEqual(800)
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab")
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      )
    }
    await page.locator(".share-preview-body").evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(
      dialog.getByRole("button", { name: "Close share details", exact: true }),
    ).toBeInViewport()
    await checkAxe(page)
    await page.locator(".share-preview-body").evaluate((element) => {
      element.scrollTop = 0
    })
    const path = testInfo.outputPath(`manage-preview-${width}.png`)
    await page.screenshot({ path, animations: "disabled" })
    await testInfo.attach(`manage-preview-${width}`, { path, contentType: "image/png" })
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await page.evaluate(() => window.scrollY)).toBe(scroll)
    expect(api.reads()).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )
  })
}

test("Escape exits an expanded preview chart before closing its parent dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = async () => {
      throw new Error("Use fullscreen fallback")
    }
  })
  await mockManagement(page)
  await page.route("**/v1/account/shares/*", (route) =>
    route.fulfill({
      headers: { "X-Morsel-Account-ID": "10000000-0000-4000-8000-000000000001" },
      json: {
        id: "chart-fixture",
        label: "Project note 30",
        created_at: created,
        expires_at: null,
        max_views: null,
        view_count: 0,
        revoked_at: null,
        status: "active",
        content:
          '# Chart preview\n\n```vega-lite\n{"data":{"values":[{"x":"A","y":1}]},"mark":"bar","encoding":{"x":{"field":"x","type":"nominal"},"y":{"field":"y","type":"quantitative"}}}\n```',
      },
    }),
  )
  await page.goto("/manage/shares")
  const trigger = page.getByRole("link", { name: "Preview share Project note 30", exact: true })
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "Share details: Project note 30", exact: true })
  const chart = dialog.locator(".vega-lite-card")
  await expect(chart.locator(".vega-lite-chart svg")).toBeVisible()
  const fullscreen = chart.getByRole("button", { name: "Fullscreen", exact: true })
  await fullscreen.click()
  await expect(chart).toHaveClass(/diagram-expanded/)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(chart).not.toHaveClass(/diagram-expanded/)
  await expect(fullscreen).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test("share controls survive section navigation and history without persisting private search", async ({
  page,
}) => {
  await mockManagement(page)
  await page.goto("/manage/shares")
  await page.getByLabel("Search shares", { exact: true }).fill("Project note")
  await page.getByRole("button", { name: "Search shares", exact: true }).click()
  await page.getByLabel("Share status", { exact: true }).selectOption("active")
  await page.getByLabel("Share order", { exact: true }).selectOption("oldest")
  await page.getByRole("button", { name: "Next shares", exact: true }).click()
  await expect(page.locator(".share-page-summary")).toContainText("Page 2")
  await page.getByLabel("Search shares", { exact: true }).fill("Unsubmitted private draft")
  await page.getByRole("link", { name: "API keys", exact: true }).click()
  await expect(page.getByRole("heading", { name: "API keys", exact: true })).toBeVisible()
  await page.getByRole("link", { name: "Security", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Passkeys", exact: true })).toBeVisible()
  await page.goBack()
  await page.goBack()
  await expect(page.getByLabel("Search shares", { exact: true })).toHaveValue(
    "Unsubmitted private draft",
  )
  await expect(page.getByLabel("Share order", { exact: true })).toHaveValue("oldest")
  await expect(page.getByLabel("Share status", { exact: true })).toHaveValue("active")
  await expect(page.locator(".share-page-summary")).toContainText("29 matching shares · Page 1")
  expect(
    await page.evaluate(
      () => JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + location.href,
    ),
  ).not.toContain("private draft")
})

test("one-time key creation focuses the save panel and blocks replacement until dismissal", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 800 })
  const api = await mockManagement(page)
  await page.goto("/manage/api-keys")
  await page.getByLabel("API key name", { exact: true }).fill("First key")
  await page.getByRole("button", { name: "Create API key", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { name: "Save your new API key", exact: true }),
  ).toBeFocused()
  await expect(page.getByRole("status")).toContainText("API key created.")
  await expect(page.getByRole("status")).not.toContainText("one-time-fixture-value")
  await expect(page.getByLabel("API key name", { exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Create API key", exact: true })).toBeDisabled()
  await page.keyboard.press("Tab")
  await expect(page.getByLabel("New API key", { exact: true })).toBeFocused()
  expect(api.creations()).toBe(1)
  await checkAxe(page)
  const path = testInfo.outputPath("manage-api-key-mobile.png")
  await page.screenshot({ path, animations: "disabled" })
  await testInfo.attach("manage-api-key-mobile", { path, contentType: "image/png" })
  await page.getByRole("button", { name: "Dismiss API key", exact: true }).click()
  await expect(page.getByRole("heading", { name: "API keys", exact: true })).toBeFocused()
  await page.getByLabel("API key name", { exact: true }).fill("Second key")
  await page.getByRole("button", { name: "Create API key", exact: true }).click()
  await expect.poll(api.creations).toBe(2)
})

test("passkey removal requires confirmation and cancellation restores focus", async ({ page }) => {
  const api = await mockManagement(page, true)
  await page.goto("/account")
  const remove = page.getByRole("button", { name: "Remove passkey Laptop", exact: true })
  await remove.click()
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused()
  expect(api.mutations).toEqual([])
  await checkAxe(page)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(remove).toBeFocused()
  expect(api.mutations).toEqual([])
  await remove.click()
  await page.getByRole("button", { name: "Confirm remove passkey", exact: true }).click()
  await expect(page.getByText("Passkey removed.", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Passkeys", exact: true })).toBeFocused()
  expect(api.mutations).toEqual(["/v1/passkeys/fixture-passkey"])
  await expect(
    page.getByRole("button", { name: "Remove passkey Phone", exact: true }),
  ).toBeDisabled()
})

for (const list of ["api-keys", "passkeys"] as const) {
  test(`${list} failures provide a read-only retry rather than a false empty state`, async ({
    page,
  }) => {
    const api = await mockManagement(page)
    api.failList(list)
    await page.goto(list === "api-keys" ? "/manage/api-keys" : "/account")
    await expect(page.getByText(/Could not load/)).toBeVisible()
    await expect(page.getByText("No API keys.", { exact: true })).toHaveCount(0)
    await expect(page.getByText(/You cannot remove your last passkey/)).toHaveCount(0)
    api.failList(null)
    await page
      .getByRole("button", {
        name: list === "api-keys" ? "Retry API keys" : "Retry passkeys",
        exact: true,
      })
      .click()
    await expect(
      page.getByText(list === "api-keys" ? "Build agent" : "Laptop", { exact: true }),
    ).toBeVisible()
    await expect(page.getByText(/Could not load/)).toHaveCount(0)
    expect(api.mutations).toEqual([])
    expect(api.creations()).toBe(0)
  })
}

test("home and example do not fetch account state, and opening a fragment share consumes once", async ({
  page,
}) => {
  const api = await mockManagement(page)
  await page.goto("/")
  await page.getByLabel("Document URL", { exact: true }).fill("javascript:alert(1)")
  await page.getByRole("button", { name: "Open document", exact: true }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  expect(api.requests).toEqual([])
  await page.getByRole("link", { name: "View example", exact: true }).click()
  await expect(page).toHaveURL(/\/example$/)
  expect(api.requests).toEqual([])
  await page.getByRole("link", { name: "Morsel home", exact: true }).click()
  await page.getByLabel("Document URL", { exact: true }).fill(`/#/s/${token}`)
  await page.getByRole("button", { name: "Open document", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Reader document", exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/#/s/${token}$`))
  expect(api.reads()).toBe(1)
  expect(api.requests).not.toContain("/v1/account")
})

test("keyboard focus follows preview, confirmation, section links, and the account menu", async ({
  page,
}) => {
  await mockManagement(page)
  await page.goto("/manage/shares")
  const preview = page.getByRole("link", { name: "Preview share Project note 30", exact: true })
  await preview.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { name: "Share details: Project note 30", exact: true }),
  ).toBeFocused()
  await page.getByRole("button", { name: "Close share details", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(preview).toBeFocused()
  const revoke = page.getByRole("button", { name: "More actions for Project note 30", exact: true })
  await revoke.focus()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("End")
  await expect(page.getByRole("menuitem", { name: "Revoke share Project note 30" })).toBeFocused()
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Cancel revocation", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(revoke).toBeFocused()
  const menu = page.getByRole("button", { name: "Account", exact: true })
  await menu.focus()
  await page.keyboard.press("Enter")
  await page.keyboard.press("End")
  await expect(page.getByRole("menuitem", { name: "Log out", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(menu).toBeFocused()
  await page.getByRole("link", { name: "Security", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/account$/)
  await expect(
    page.getByRole("button", { name: "Remove passkey Laptop", exact: true }),
  ).toBeDisabled()
  await expect(page.getByText(/last passkey/i)).toBeVisible()
})

test("one-time keys warn before links and native history navigation discard them after refresh", async ({
  page,
}) => {
  await mockManagement(page)
  await page.goto("/")
  await page.getByRole("link", { name: "Manage", exact: true }).click()
  await page.getByRole("link", { name: "API keys", exact: true }).click()
  await page.reload()
  await page.getByLabel("API key name", { exact: true }).fill("Browser key")
  await page.getByRole("button", { name: "Create API key", exact: true }).click()
  await expect(page.getByLabel("New API key", { exact: true })).toHaveValue(
    "one-time-fixture-value-not-a-real-api-key",
  )
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("link", { name: "Security", exact: true }).click()
  await expect(page).toHaveURL(/\/manage\/api-keys$/)
  await expect(page.getByLabel("New API key", { exact: true })).toBeVisible()
  const dismissed = page.waitForEvent("dialog")
  await page.evaluate(() => history.back())
  await (await dismissed).dismiss()
  await expect(page).toHaveURL(/\/manage\/api-keys$/)
  await expect(page.getByLabel("New API key", { exact: true })).toBeVisible()
  const accepted = page.waitForEvent("dialog")
  await page.evaluate(() => history.back())
  await (await accepted).accept()
  await expect(page).toHaveURL(/\/manage\/shares$/)
  await expect(page.getByLabel("New API key", { exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage)),
  ).not.toContain("one-time-fixture-value")
  await page.goForward()
  await expect(page).toHaveURL(/\/manage\/api-keys$/)
  await expect(page.getByLabel("New API key", { exact: true })).toHaveCount(0)
})

test("long Unicode titles and administrative IDs fit at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await mockManagement(page)
  await page.goto("/manage/shares")
  const title = page.getByRole("link", { name: `Preview share ${longTitle}`, exact: true })
  await expect(title).toHaveAttribute("title", longTitle)
  expect(
    await title.locator("span").evaluate((element) => {
      const style = getComputedStyle(element)
      return element.getBoundingClientRect().height <= 2 * Number.parseFloat(style.lineHeight) + 1
    }),
  ).toBe(true)
  await title.click()
  await expect(
    page.getByRole("heading", { name: `Share details: ${longTitle}`, exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText("00000000-0000-4000-8000-000000000008", { exact: true }),
  ).toBeVisible()
  await checkAxe(page)
})

for (const fragment of [false, true]) {
  test(`document anchors retain native scrolling and the reader with fragment=${fragment}`, async ({
    page,
  }) => {
    let reads = 0
    let accounts = 0
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/v1/account") accounts += 1
    })
    await page.route(`**/v1/shares/${token}`, (route) => {
      reads += 1
      return route.fulfill({
        json: {
          content: `# Anchor document\n\n${"Paragraph for scrolling.\n\n".repeat(160)}[Back to top](#)\n\n[Document controls](#document-title)`,
          created_at: created,
          view_count: reads,
        },
      })
    })
    const destination = fragment ? `/#/s/${token}` : `/s/${token}`
    await page.goto(destination)
    await expect(page.getByRole("heading", { name: "Anchor document", exact: true })).toBeVisible()
    await page.getByRole("link", { name: "Back to top", exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    await page.getByRole("link", { name: "Document controls", exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(250)
    if (fragment) await expect(page).toHaveURL(new RegExp(`/#/s/${token}$`))
    await expect(page.getByRole("heading", { name: "Anchor document", exact: true })).toBeVisible()
    expect(reads).toBe(1)
    expect(accounts).toBe(0)
  })
}
