import { expect, type Page, test } from "@playwright/test"

const token = "V".repeat(43)
const content = `# Vega-Lite charts

\`\`\`vega-lite
{
  "data": {
    "values": [
      {"week": "W1", "requests": 120},
      {"week": "W2", "requests": 180},
      {"week": "W3", "requests": 150}
    ]
  },
  "description": "Weekly request volume",
  "mark": "bar",
  "encoding": {
    "x": {"field": "week", "type": "nominal"},
    "y": {"field": "requests", "type": "quantitative"}
  }
}
\`\`\`

\`\`\`vega-lite
{
  "data": {"url": "https://evil.example/data.csv"},
  "mark": "bar",
  "encoding": {"x": {"field": "week"}, "y": {"field": "requests"}}
}
\`\`\``

async function mockShare(page: Page) {
  await page.route(`**/v1/shares/${token}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        content,
        created_at: "2026-01-01T00:00:00Z",
        view_count: 1,
        views_remaining: null,
      }),
    }),
  )
}

test("renders inline Vega-Lite data and blocks external resources", async ({ page }) => {
  const externalRequests: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url())
  })
  await mockShare(page)
  await page.goto(`#/s/${token}`)

  const charts = page.locator(".vega-lite-chart")
  await expect(charts).toHaveCount(2)
  await expect(charts.first().locator("svg")).toBeVisible()
  await expect(charts.first()).toContainText("W1")
  const card = page.locator(".vega-lite-card").first()
  const viewport = card.getByRole("region", { name: /Interactive Vega-Lite chart/ })
  await expect(card.getByRole("button", { name: "Fit to screen" })).toBeVisible()
  await expect(card.getByRole("button", { name: "Fullscreen" })).toBeVisible()
  await card.getByRole("button", { name: "Zoom in" }).click()
  await expect(card.getByLabel("Current zoom")).not.toHaveText("100%")
  await card.getByRole("button", { name: "Fit to screen" }).click()
  await expect
    .poll(async () => {
      const view = await viewport.boundingBox()
      const chart = await charts.first().boundingBox()
      return Boolean(
        view && chart && chart.width <= view.width + 1 && chart.height <= view.height + 1,
      )
    })
    .toBe(true)

  const downloadPromise = page.waitForEvent("download")
  await card.getByRole("button", { name: "Download SVG" }).click()
  expect((await downloadPromise).suggestedFilename()).toBe("vega-lite-chart.svg")

  await card.getByRole("button", { name: "Show source" }).click()
  await expect(card.locator("pre")).toContainText('"mark": "bar"')
  await card.getByRole("button", { name: "Show chart" }).click()

  const accessibleView = charts.first().locator('.vega-lite-render[role="graphics-document"]')
  await expect(accessibleView).toHaveAttribute("aria-label", "Weekly request volume")
  await expect(charts.nth(1).locator("svg")).toBeVisible()
  await expect(page.locator("pre code.language-vega-lite")).toHaveCount(0)
  expect(externalRequests).toEqual([])
})
