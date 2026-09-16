import { expect, test } from "@playwright/test"

const token = "A".repeat(43)
const content = `# Browser smoke

| Feature | Works |
| --- | --- |
| GFM | yes |

Inline $x^2$.

\`\`\`mermaid
graph TD
  A --> B
\`\`\``

test.beforeEach(async ({ page }) => {
  await page.route(`http://127.0.0.1:8080/v1/shares/${token}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        content,
        created_at: "2026-01-01T00:00:00Z",
        view_count: 1,
        views_remaining: 4,
      }),
    })
  })
})

test("renders safely under the production CSP and uses one request", async ({ page }) => {
  let requests = 0
  page.on("request", (request) => {
    if (request.url().includes(`/v1/shares/${token}`)) requests += 1
  })
  await page.goto(`#/s/${token}`)
  await expect(page.getByRole("heading", { name: "Browser smoke" })).toBeVisible()
  await expect(page.getByRole("table")).toBeVisible()
  await expect(page.locator(".katex")).toBeVisible()
  await expect(page.getByLabel("Mermaid diagram")).toBeVisible()
  expect(requests).toBe(1)

  const blocked = await page.evaluate(async () => {
    try {
      await fetch("https://evil.invalid/must-be-blocked")
      return false
    } catch {
      return true
    }
  })
  expect(blocked).toBe(true)
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content")
  expect(csp).toContain("connect-src 'self' http://127.0.0.1:8080")
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer")
})

test("supports keyboard navigation at desktop and narrow widths", async ({ page }) => {
  const viewports = [
    { width: 1280, height: 800 },
    { width: 375, height: 667 },
  ]
  for (const [index, viewport] of viewports.entries()) {
    await page.setViewportSize(viewport)
    if (index === 0) await page.goto(`#/s/${token}`)
    else await page.reload()
    await expect(page.getByRole("heading", { name: "Browser smoke" })).toBeVisible()
    await page.keyboard.press("Tab")
    await expect(page.locator(":focus")).toBeVisible()
    await page.getByRole("button", { name: "Show raw Markdown" }).focus()
    await page.keyboard.press("Enter")
    await expect(page.locator(".raw-markdown")).toContainText("Browser smoke")
  }
})
