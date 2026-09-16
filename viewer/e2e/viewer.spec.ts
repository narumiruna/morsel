import { expect, test } from "@playwright/test"

const token = "A".repeat(43)
const content = `# Browser smoke

| Feature | Works |
| --- | --- |
| GFM | yes |

Inline $x^2$.

\`\`\`go
package main

func main() {
  println("hello")
}
\`\`\`

\`\`\`mermaid
flowchart LR
  Browser --> API
\`\`\``

test.beforeEach(async ({ page }) => {
  await page.route(`**/v1/shares/${token}`, async (route) => {
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
  const response = await page.goto(`#/s/${token}`)
  expect(response).not.toBeNull()
  await expect(page.getByRole("heading", { name: "Browser smoke" })).toBeVisible()
  await expect(page.getByRole("table")).toBeVisible()
  await expect(page.locator(".katex")).toBeVisible()
  await expect(page.locator("pre code.hljs.language-go .hljs-keyword").first()).toContainText(
    "package",
  )
  const diagram = page.getByLabel("Mermaid diagram")
  await expect(diagram).toBeVisible()
  await expect(diagram.locator("svg text")).toContainText(["Browser", "API"])
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
  const headers = response?.headers() ?? {}
  expect(headers["content-security-policy"]).toContain("connect-src 'self'")
  expect(headers["content-security-policy"]).not.toContain("127.0.0.1:12647")
  expect(headers["referrer-policy"]).toBe("no-referrer")
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
