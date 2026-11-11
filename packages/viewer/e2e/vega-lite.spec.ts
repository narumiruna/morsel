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

async function mockShare(page: Page, shareContent = content) {
  await page.route(`**/v1/shares/${token}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        content: shareContent,
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

test("keeps native Vega range input pointer and keyboard controls usable", async ({ page }) => {
  await page.addInitScript(() => {
    HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("Use fallback"))
  })
  await mockShare(
    page,
    `\`\`\`vega-lite
${JSON.stringify({
  data: { values: [{ category: "A", amount: 10 }] },
  params: [{ name: "opacity", value: 0.5, bind: { input: "range", min: 0, max: 1, step: 0.1 } }],
  mark: { type: "bar", opacity: { expr: "opacity" } },
  encoding: {
    x: { field: "category", type: "nominal" },
    y: { field: "amount", type: "quantitative" },
  },
})}
\`\`\``,
  )
  await page.goto(`#/s/${token}`)
  const card = page.locator(".vega-lite-card")
  await expect(card).toHaveAttribute("aria-busy", "false")
  const stage = card.locator(".vega-lite-chart")
  const slider = card.getByRole("slider")
  const graphic = stage.locator("svg")

  for (const expanded of [false, true]) {
    if (expanded) {
      await card.getByRole("button", { name: "Fullscreen", exact: true }).click()
      await expect(card).toHaveClass(/diagram-expanded/)
      await expect(card.getByRole("region", { name: /Interactive Vega-Lite chart/ })).toBeFocused()
      await expect(slider).toHaveValue("0.5")
    }
    const zoom = await card.getByLabel("Current zoom").textContent()
    const transform = await stage.evaluate((element) => element.style.transform)
    const before = await graphic.innerHTML()
    await slider.focus()
    await slider.press("ArrowRight")
    await expect(slider).toHaveValue("0.6")
    await expect.poll(() => graphic.innerHTML()).not.toBe(before)
    await slider.press("ArrowLeft")
    await expect(slider).toHaveValue("0.5")

    const box = await slider.boundingBox()
    if (!box) throw new Error("range input missing")
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2)
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0.5)
    const value = Number(await slider.inputValue())
    const afterClick = await graphic.innerHTML()
    await page.mouse.move(box.x + 8 + (box.width - 16) * value, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(value)
    await expect.poll(() => graphic.innerHTML()).not.toBe(afterClick)
    await expect(card.getByLabel("Current zoom")).toHaveText(zoom ?? "")
    expect(await stage.evaluate((element) => element.style.transform)).toBe(transform)

    // Restore the native control value through its own keyboard behavior.
    await slider.focus()
    await slider.press("Home")
    for (let step = 0; step < 5; step++) await slider.press("ArrowRight")
    await expect(slider).toHaveValue("0.5")
  }
  await slider.press("Escape")
  await expect(card).not.toHaveClass(/diagram-expanded/)
})

test("zooms back to the actual overview floor below 25 percent", async ({ page }) => {
  await mockShare(
    page,
    `\`\`\`vega-lite
${JSON.stringify({
  width: 5000,
  height: 300,
  data: { values: [{ category: "A", amount: 10 }] },
  mark: "bar",
  encoding: {
    x: { field: "category", type: "nominal" },
    y: { field: "amount", type: "quantitative" },
  },
})}
\`\`\``,
  )
  await page.goto(`#/s/${token}`)
  const card = page.locator(".vega-lite-card")
  await expect(card).toHaveAttribute("aria-busy", "false")
  const stage = card.locator(".vega-lite-chart")
  const zoomOut = card.getByRole("button", { name: "Zoom out" })
  await expect(zoomOut).toBeDisabled()
  const overview = await stage.evaluate((element) => element.style.transform)
  const percentage = Number((await card.getByLabel("Current zoom").textContent())?.replace("%", ""))
  expect(percentage).toBeLessThan(25)
  await card.getByRole("button", { name: "Zoom in" }).click()
  await expect(zoomOut).toBeEnabled()
  await zoomOut.click()
  await expect(zoomOut).toBeDisabled()
  expect(await stage.evaluate((element) => element.style.transform)).toBe(overview)
})
