import { expect, test } from "@playwright/test"

const token = "A".repeat(43)
const gist = "7dbaf8170c7292354678069a9acb061f"
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
  const response = await page.goto(`/s/${token}`)
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

test("loads Gist Markdown directly from GitHub without credentials", async ({ page }) => {
  let requests = 0
  let authorization = ""
  await page.route(`https://api.github.com/gists/${gist}`, async (route) => {
    requests += 1
    authorization = route.request().headers().authorization ?? ""
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        files: {
          "README.md": {
            filename: "README.md",
            language: "Markdown",
            content: "# Browser Gist",
            truncated: false,
          },
          "charts.md": {
            filename: "charts.md",
            language: "Markdown",
            content: "# Gist Charts",
            truncated: false,
          },
        },
      }),
    })
  })

  const response = await page.goto(`/gist/#${gist}`)
  expect(response).not.toBeNull()
  await expect(page.getByRole("heading", { name: "Browser Gist" })).toBeVisible()
  const fileSelector = page.getByRole("combobox", { name: "Markdown file" })
  await expect(fileSelector).toContainText("README.md")
  await fileSelector.click()
  await page.getByRole("option", { name: "charts.md" }).click()
  await expect(page.getByRole("heading", { name: "Gist Charts" })).toBeVisible()
  expect(requests).toBe(1)
  expect(authorization).toBe("")
  expect(response?.headers()["content-security-policy"]).toContain(
    "connect-src 'self' https://api.github.com",
  )
})

for (const width of [1280, 375]) {
  for (const theme of ["light", "dark"]) {
    test(`Gist file picker fits ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 })
      await page.addInitScript((mode) => localStorage.setItem("morsel-theme", mode), theme)
      const filenames = [
        "01-flow-and-growth.md",
        "02-system-and-distribution.md",
        `03-${"long-filename-".repeat(8)}correlation.md`,
      ]
      await page.route(`https://api.github.com/gists/${gist}`, (route) =>
        route.fulfill({
          json: {
            files: Object.fromEntries(
              filenames.map((filename, index) => [
                filename,
                { filename, language: "Markdown", content: `# Document ${index + 1}` },
              ]),
            ),
          },
        }),
      )
      await page.goto(`/gist/#${gist}`)
      await expect(page.getByRole("heading", { name: "Document 1" })).toBeVisible()
      const picker = page.getByRole("combobox", { name: "Markdown file" })
      const header = await page.locator(".document-header").boundingBox()
      const trigger = await picker.boundingBox()
      expect(trigger?.y).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0))

      await picker.focus()
      await page.keyboard.press("ArrowDown")
      const menu = page.getByRole("listbox")
      await expect(menu).toBeVisible()
      const menuBox = await menu.boundingBox()
      expect(menuBox?.y).toBeGreaterThanOrEqual((trigger?.y ?? 0) + (trigger?.height ?? 0))
      expect(menuBox?.x).toBeGreaterThanOrEqual(0)
      expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(width)
      await testInfo.attach("file-picker", {
        body: await page.screenshot({ animations: "disabled" }),
        contentType: "image/png",
      })
      await expect(page.getByRole("option").first()).toBeFocused()
      await page.keyboard.press("End")
      await expect(page.getByRole("option").last()).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(page.getByRole("heading", { name: "Document 3" })).toBeVisible()
      await expect(picker).toBeFocused()
      await expect(picker).toHaveAttribute("title", filenames[2])
      const filename = picker.locator(".gist-file-name")
      expect(await filename.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      )
      const filenameBox = await filename.boundingBox()
      const selectedTrigger = await picker.boundingBox()
      expect((filenameBox?.x ?? 0) + (filenameBox?.width ?? 0)).toBeLessThanOrEqual(
        (selectedTrigger?.x ?? 0) + (selectedTrigger?.width ?? 0),
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      await picker.click()
      await page.keyboard.press("Escape")
      await expect(menu).not.toBeVisible()
      await expect(picker).toBeFocused()
    })
  }
}

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
