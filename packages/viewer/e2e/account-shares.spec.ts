import { expect, type Page, test } from "@playwright/test"

const created = "2026-10-21T10:00:00Z"
const firstID = "a0000000-0000-4000-8000-000000000001"
const secondID = "a0000000-0000-4000-8000-000000000002"

async function mockAccount(page: Page) {
  let expiredSession = false
  let revoked = false
  let publicRequests = 0
  const deletions: string[] = []
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
      const status = url.searchParams.get("status")
      const cursor = url.searchParams.get("cursor")
      expect(url.searchParams.get("limit")).toBe("25")
      if (status === "all") {
        await route.fulfill({
          json: cursor ? { items: [second] } : { items: [first()], next_cursor: "opaque/+=" },
        })
      } else {
        expect(cursor).toBeNull()
        await route.fulfill({
          json: { items: [first(), second].filter((share) => share.status === status) },
        })
      }
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
    publicRequests: () => publicRequests,
    expireSession: () => {
      expiredSession = true
    },
  }
}

for (const width of [1280, 390]) {
  test(`manages historical and unavailable shares without consuming views at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const api = await mockAccount(page)
    await page.goto("/account")
    const shares = page.getByRole("region", { name: "Shares", exact: true })
    await expect(shares.getByRole("button", { name: "View share Historical share" })).toBeVisible()
    await expect(shares.getByText(firstID, { exact: true })).toBeVisible()
    await expect(shares.getByText(/before account setup/)).toBeVisible()
    await shares.getByRole("button", { name: "Next shares" }).click()
    await expect(shares.getByRole("button", { name: "View share Expired share" })).toBeVisible()
    await shares.getByLabel("Share status").selectOption("expired")
    await expect(shares.getByRole("button", { name: "Previous shares" })).toBeDisabled()
    await shares.getByRole("button", { name: "View share Expired share" }).click()
    const expiredDetail = shares.getByRole("region", { name: "Share details: Expired share" })
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
    await expect(shares.getByRole("button", { name: /copy.*(url|link)/i })).toHaveCount(0)
    await shares.getByRole("button", { name: "Close share details" }).click()
    await shares.getByLabel("Share status").selectOption("all")
    await shares.getByRole("button", { name: "View share Historical share" }).click()
    const detail = shares.getByRole("region", { name: "Share details: Historical share" })
    await expect(detail.getByRole("heading", { name: "Private content" })).toBeVisible()
    await shares.getByRole("button", { name: "Revoke share Historical share" }).click()
    expect(api.deletions).toHaveLength(0)
    await expect(shares.getByText(/This cannot be undone/)).toBeVisible()
    await shares.getByRole("button", { name: "Cancel revocation" }).click()
    await shares.getByRole("button", { name: "Revoke share Historical share" }).click()
    await shares.getByRole("button", { name: "Confirm revocation" }).click()
    await expect(shares.getByText(/Share revoked\. Copies/)).toBeVisible()
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

test("session expiry removes administrative content and metadata", async ({ page }) => {
  const api = await mockAccount(page)
  await page.goto("/account")
  await page.getByRole("button", { name: "View share Historical share" }).click()
  await expect(page.getByRole("heading", { name: "Private content" })).toBeVisible()
  api.expireSession()
  await page.getByRole("button", { name: "Refresh shares" }).click()
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible()
  await expect(page.getByText("Your session expired. Sign in again.")).toBeVisible()
  await expect(page.getByRole("region", { name: "Shares", exact: true })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Private content" })).toHaveCount(0)
  await expect(page.getByText(firstID, { exact: true })).toHaveCount(0)
  expect(api.publicRequests()).toBe(0)
})
