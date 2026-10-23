import { expect, type Page, test } from "@playwright/test"
import axe from "axe-core"

const created = "2026-10-21T10:00:00Z"
const firstID = "a0000000-0000-4000-8000-000000000001"
const secondID = "a0000000-0000-4000-8000-000000000002"
const firstToken = "A".repeat(43)
const secondToken = `${"B".repeat(42)}A`

async function revokeShare(page: Page, label: string) {
  await page.getByRole("button", { name: `More actions for ${label}`, exact: true }).click()
  await page.getByRole("menuitem", { name: `Revoke share ${label}`, exact: true }).click()
  await expect(
    page.getByRole("heading", { name: `Revoke share ${label}?`, exact: true }),
  ).toBeFocused()
}

async function mockAccount(page: Page) {
  let expiredSession = false
  let revoked = false
  let publicRequests = 0
  const deletions: string[] = []
  const listQueries: URLSearchParams[] = []
  const first = () => ({
    id: firstID,
    label: "Historical share",
    created_at: created,
    expires_at: null,
    max_views: 5,
    view_count: 2,
    revoked_at: revoked ? created : null,
    status: revoked ? "revoked" : "active",
  })
  const second = {
    ...first(),
    id: secondID,
    label: "Expired share",
    view_count: 9,
    expires_at: created,
    status: "expired",
  }
  await page.route("**/v1/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path.startsWith("/v1/shares")) {
      publicRequests += 1
      await route.fulfill({ status: 500, body: "Public reads are forbidden in this scenario." })
      return
    }
    if (expiredSession && path.startsWith("/v1/account")) {
      await route.fulfill({ status: 401, json: { code: "session_expired" } })
      return
    }
    if (path === "/v1/account") {
      await route.fulfill({
        json: {
          authenticated: true,
          setup_required: false,
          csrf_token: "current-csrf",
          verification_required: false,
        },
      })
    } else if (path === "/v1/passkeys") {
      await route.fulfill({ json: [{ id: "passkey", name: "Laptop", created_at: created }] })
    } else if (path === "/v1/api-keys") {
      await route.fulfill({ json: [] })
    } else if (path === "/v1/account/shares") {
      listQueries.push(url.searchParams)
      const status = url.searchParams.get("status")
      const cursor = url.searchParams.get("cursor")
      expect(url.searchParams.get("limit")).toBe("25")
      if (status === "all") {
        const items =
          url.searchParams.get("sort") === "most_views" ? [second, first()] : [first(), second]
        await route.fulfill({
          json: cursor
            ? { items: [items[1]], matching_count: 2 }
            : { items: [items[0]], next_cursor: "opaque/+=", matching_count: 2 },
        })
      } else {
        expect(cursor).toBeNull()
        await route.fulfill({
          json: {
            items: [first(), second].filter((share) => share.status === status),
            matching_count: [first(), second].filter((share) => share.status === status).length,
          },
        })
      }
    } else if (path.endsWith("/link") && request.method() === "POST") {
      expect(request.headers()["x-csrf-token"]).toBe("current-csrf")
      const token = path.includes(secondID) ? secondToken : firstToken
      expect(request.postDataJSON()).toEqual({ token })
      await route.fulfill({
        json: { share_url: `${url.origin}/${path.includes(secondID) ? "s/" : "#/s/"}${token}` },
      })
    } else if (path === `/v1/account/shares/${firstID}` && request.method() === "DELETE") {
      expect(request.headers()["x-csrf-token"]).toBe("current-csrf")
      deletions.push(path)
      revoked = true
      await route.fulfill({ status: 204 })
    } else if (path.startsWith("/v1/account/shares/")) {
      const metadata = path.endsWith(secondID) ? second : first()
      await route.fulfill({
        json: {
          ...metadata,
          content: `# Private content\n\n**Administrative read**\n\n![no consuming image](/v1/shares/${"A".repeat(43)})\n\n\`\`\`mermaid\nflowchart TD\nA@{ img: "/v1/shares/${"A".repeat(43)}", label: "test", h: 60 }\n\`\`\`\n\n<script>window.unsafe = true</script>\n\n[unsafe](javascript:alert(1))`,
        },
      })
    } else {
      throw new Error(`Unexpected account request: ${request.method()} ${path}`)
    }
  })
  return {
    deletions,
    listQueries,
    publicRequests: () => publicRequests,
    expireSession: () => {
      expiredSession = true
    },
  }
}

for (const width of [1280, 375]) {
  test(`sorts all shares by views and creation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const api = await mockAccount(page)
    await page.goto("/manage/shares")
    await page.getByRole("button", { name: "Next shares" }).click()
    await expect(page.getByText("2 matching shares · Page 2")).toBeVisible()
    if (width > 600) {
      const views = page.getByRole("button", { name: "Views", exact: true })
      await views.focus()
      await page.keyboard.press("Enter")
      await expect(views).toBeFocused()
    } else {
      await page.getByLabel("Share order").selectOption("most_views")
    }
    await expect(page.getByText("2 matching shares · Page 1")).toBeVisible()
    await expect(page.getByRole("link", { name: "Preview share Expired share" })).toBeVisible()
    await expect(page.getByLabel("Share order")).toHaveValue("most_views")
    expect(api.listQueries.at(-1)?.get("sort")).toBe("most_views")
    expect(api.listQueries.at(-1)?.has("cursor")).toBe(false)
    await expect(page.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    if (width > 600) {
      await expect(page.getByRole("columnheader", { name: "Views", exact: true })).toHaveAttribute(
        "aria-sort",
        "descending",
      )
      await page.keyboard.press("Space")
    } else {
      await page.getByLabel("Share order").selectOption("least_views")
    }
    await expect(page.getByRole("link", { name: "Preview share Historical share" })).toBeVisible()
    await expect(page.getByLabel("Share order")).toHaveValue("least_views")
    expect(api.listQueries.at(-1)?.get("sort")).toBe("least_views")
    if (width > 600) {
      await expect(page.getByRole("columnheader", { name: "Views", exact: true })).toHaveAttribute(
        "aria-sort",
        "ascending",
      )
      await page.getByRole("button", { name: "Created", exact: true }).click()
      await expect(page.getByLabel("Share order")).toHaveValue("newest")
      await page.getByRole("button", { name: "Created", exact: true }).click()
    } else {
      await page.getByLabel("Share order").selectOption("oldest")
    }
    await expect(page.getByLabel("Share order")).toHaveValue("oldest")
    expect(api.listQueries.at(-1)?.get("sort")).toBe("oldest")
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    expect(api.publicRequests()).toBe(0)
  })

  test(`manages historical and unavailable shares without consuming views at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const api = await mockAccount(page)
    await page.goto("/manage/shares")
    const shares = page.getByRole("region", { name: "Shares", exact: true })
    await expect(shares.getByRole("link", { name: "Preview share Historical share" })).toBeVisible()
    await expect(shares.getByText(firstID, { exact: true })).toHaveCount(0)
    await shares.getByText("About share management", { exact: true }).click()
    await expect(shares.getByText(/before account setup/)).toBeVisible()
    await shares.getByText("About share management", { exact: true }).click()
    await shares.getByRole("button", { name: "Next shares" }).click()
    await expect(shares.getByRole("link", { name: "Preview share Expired share" })).toBeVisible()
    await shares.getByLabel("Share status").selectOption("expired")
    await expect(shares.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    await shares.getByRole("link", { name: "Preview share Expired share" }).click()
    const expiredDetail = page.getByRole("dialog", { name: "Share details: Expired share" })
    await expect(expiredDetail.getByRole("heading", { name: "Private content" })).toBeVisible()
    await expect(expiredDetail.getByText("Expired", { exact: true })).toBeVisible()
    await expect(expiredDetail.getByText(/original public URL cannot be recovered/)).toBeVisible()
    await expect(expiredDetail.locator("script")).toHaveCount(0)
    await expect(expiredDetail.locator("img")).toHaveCount(0)
    await expect(expiredDetail.locator("pre > code.language-mermaid")).toBeVisible()
    await expect(
      expiredDetail.getByText("Image not loaded: no consuming image", { exact: true }),
    ).toBeVisible()
    await expect(expiredDetail.getByText("unsafe", { exact: true })).not.toHaveAttribute(
      "href",
      /javascript:/,
    )
    await expect(expiredDetail.getByRole("button", { name: /copy.*(url|link)/i })).toHaveCount(0)
    await expiredDetail.getByRole("button", { name: "Close share details" }).click()
    await shares.getByLabel("Share status").selectOption("all")
    await shares.getByRole("link", { name: "Preview share Historical share" }).click()
    const detail = page.getByRole("dialog", { name: "Share details: Historical share" })
    await expect(detail.getByRole("heading", { name: "Private content" })).toBeVisible()
    await detail.getByRole("button", { name: "Close share details" }).click()
    await revokeShare(page, "Historical share")
    expect(api.deletions).toHaveLength(0)
    await expect(shares.getByText(/This cannot be undone/)).toBeVisible()
    await shares.getByRole("button", { name: "Cancel revocation" }).click()
    await revokeShare(page, "Historical share")
    await shares.getByRole("button", { name: "Confirm revocation" }).click()
    await expect(shares.getByText(/Share revoked\. Copies/)).toBeVisible()
    const heading = shares.getByRole("heading", { name: "Shares", exact: true })
    await expect(heading).toBeFocused()
    expect((await heading.boundingBox())?.height).toBeGreaterThan(20)
    await shares.getByRole("link", { name: "Preview share Historical share" }).click()
    await expect(detail.getByText("Revoked", { exact: true }).first()).toBeVisible()
    await expect(
      detail
        .locator("dl > div")
        .filter({ has: page.locator("dt", { hasText: /^Views$/ }) })
        .locator("dd"),
    ).toHaveText("2")
    expect(api.deletions).toHaveLength(1)
    expect(api.publicRequests()).toBe(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    const screenshotName = width === 1280 ? "share-management-desktop" : "share-management-mobile"
    const screenshotPath = testInfo.outputPath(`${screenshotName}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    await testInfo.attach(screenshotName, { path: screenshotPath, contentType: "image/png" })
  })
}

for (const width of [1280, 375, 320]) {
  test(`copies canonical row URLs with keyboard and manual fallback at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    const api = await mockAccount(page)
    await page.addInitScript(() => {
      const state = window as typeof window & { copiedLinks: string[]; failClipboard: boolean }
      state.copiedLinks = []
      state.failClipboard = false
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            if (state.failClipboard) throw new Error("Clipboard denied")
            state.copiedLinks.push(value)
          },
        },
      })
    })
    await page.goto("/manage/shares")
    const copy = page.getByRole("button", { name: "Copy link for Historical share", exact: true })
    await copy.focus()
    await page.keyboard.press("Enter")
    const link = page.getByRole("dialog", { name: "Public link: Historical share" })
    await expect(link.getByText(/cannot recover the original public URL/)).toBeVisible()
    await link
      .getByRole("textbox", { name: "Original public URL" })
      .fill(`${new URL(page.url()).origin}/s/${firstToken}`)
    await link.getByRole("button", { name: "Use original link" }).click()
    const canonical = `${new URL(page.url()).origin}/#/s/${firstToken}`
    const input = link.getByRole("textbox", { name: "Public share URL" })
    await expect(input).toHaveValue(canonical)
    await expect(input).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(copy).toBeFocused()
    const focus = await copy.evaluate((element) => getComputedStyle(element).outlineStyle)
    expect(focus).not.toBe("none")
    await page.keyboard.press("Enter")
    await expect(page.getByText("Link copied. Historical share", { exact: true })).toBeVisible()
    await page.evaluate(() => {
      ;(window as typeof window & { failClipboard: boolean }).failClipboard = true
    })
    await copy.click()
    await expect(link.getByRole("status")).toContainText("Could not copy link")
    await expect(input).toHaveValue(canonical)
    await link.getByRole("button", { name: "Select link" }).click()
    expect(
      await input.evaluate((element) => {
        const field = element as HTMLTextAreaElement
        return field.value.slice(field.selectionStart, field.selectionEnd)
      }),
    ).toBe(canonical)
    await page.evaluate(axe.source)
    expect(
      await page.evaluate(async () => {
        const browserAxe = (window as unknown as { axe: typeof axe }).axe
        return (await browserAxe.run(document.body)).violations
      }),
    ).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )
    await page.keyboard.press("Escape")
    const more = page.getByRole("button", { name: "More actions for Historical share" })
    await more.focus()
    await page.keyboard.press("ArrowDown")
    await expect(page.getByRole("menuitem", { name: "Show link" })).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(input).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(more).toBeFocused()
    await page.evaluate(() => {
      ;(window as typeof window & { failClipboard: boolean }).failClipboard = false
    })
    await page.getByRole("button", { name: "Next shares" }).click()
    await page.getByRole("button", { name: "Copy link for Expired share" }).click()
    const expired = page.getByRole("dialog", { name: "Public link: Expired share" })
    await expect(expired.getByText(/Expired.*no longer grants public access/)).toBeVisible()
    await expired
      .getByRole("textbox", { name: "Original public URL" })
      .fill(`${new URL(page.url()).origin}/#/s/${secondToken}`)
    await expired.getByRole("button", { name: "Use original link" }).click()
    await expired.getByRole("button", { name: "Copy link", exact: true }).click()
    expect(
      await page.evaluate(() => (window as typeof window & { copiedLinks: string[] }).copiedLinks),
    ).toEqual([canonical, `${new URL(page.url()).origin}/s/${secondToken}`])
    expect(api.publicRequests()).toBe(0)
    expect(api.deletions).toHaveLength(0)
    await page.keyboard.press("Escape")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )
  })
}

test("session expiry removes administrative content and metadata", async ({ page }) => {
  const api = await mockAccount(page)
  await page.goto("/manage/shares")
  await page.getByRole("link", { name: "Preview share Historical share" }).click()
  await expect(page.getByRole("heading", { name: "Private content" })).toBeVisible()
  api.expireSession()
  await page.getByRole("button", { name: "Close share details" }).click()
  await page.getByRole("link", { name: "Preview share Historical share" }).click()
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible()
  await expect(page.getByText("Your session expired. Sign in again.")).toBeVisible()
  await expect(page.getByRole("region", { name: "Shares", exact: true })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Private content" })).toHaveCount(0)
  await expect(page.getByText(firstID, { exact: true })).toHaveCount(0)
  expect(api.publicRequests()).toBe(0)
})
