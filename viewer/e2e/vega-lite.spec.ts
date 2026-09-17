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
  await expect(charts.nth(1).locator("svg")).toBeVisible()
  await expect(page.locator("pre code.language-vega-lite")).toHaveCount(0)
  expect(externalRequests).toEqual([])
})
