import { readFile } from "node:fs/promises"
import { expect, type Page, test } from "@playwright/test"

const token = "M".repeat(43)
const spacer = Array.from(
  { length: 120 },
  (_, index) =>
    `Paragraph ${index}: enough text to keep the next diagram outside the preload margin.`,
).join("\n\n")
const content = `# Mermaid interactions

\`\`\`mermaid
flowchart LR
  A[Browser client] --> B[API gateway] --> C[Queue worker] --> D[Database storage] --> E[Audit service] --> F[Reader]
\`\`\`

\`\`\`mermaid
flowchart LR
  Broken -->
\`\`\`

${spacer}

\`\`\`mermaid
flowchart TD
  Start --> One --> Two --> Three --> Four --> Five --> Six --> Finish
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
        views_remaining: 4,
      }),
    }),
  )
}

test.beforeEach(async ({ page }) => {
  await mockShare(page)
})

test("fits, navigates, rerenders by theme, exports PNG, and stays local", async ({ page }) => {
  const externalRequests: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url())
  })
  const response = await page.goto(`#/s/${token}`)
  const card = page.locator(".diagram-card").first()
  await expect(card.getByRole("img", { name: "Mermaid diagram" })).toBeVisible()
  const viewport = card.getByRole("region", { name: /Interactive Mermaid diagram/ })
  const stage = card.locator(".mermaid-diagram")

  await expect
    .poll(async () => {
      const view = await viewport.boundingBox()
      const diagram = await stage.boundingBox()
      return Boolean(
        view && diagram && diagram.width <= view.width + 1 && diagram.height <= view.height + 1,
      )
    })
    .toBe(true)

  await card.getByRole("button", { name: "Use readable view" }).click()
  await expect(card.getByRole("button", { name: "Show overview" })).toBeVisible()
  const readableTransform = await stage.getAttribute("style")
  await viewport.focus()
  await viewport.press("+")
  await expect(card.getByLabel("Current zoom")).not.toHaveText("100%")
  await viewport.press("0")
  await expect(card.getByRole("button", { name: "Use readable view" })).toBeVisible()

  for (let count = 0; count < 5; count += 1) {
    await card.getByRole("button", { name: "Zoom in" }).click()
  }
  const beforePan = await stage.getAttribute("style")
  const box = await viewport.boundingBox()
  if (!box) throw new Error("diagram viewport missing")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2)
  await page.mouse.up()
  expect(await stage.getAttribute("style")).not.toBe(beforePan)
  expect(readableTransform).toContain("scale(1)")

  const diagramSvg = card.locator(".mermaid-diagram > svg")
  const lightSvg = await diagramSvg.evaluate((element) => element.outerHTML)
  await page.getByRole("combobox", { name: "Theme" }).click()
  await page.getByRole("option", { name: "Dark" }).click()
  await expect(page.locator('[data-appearance="dark"]')).toBeVisible()
  await expect.poll(() => diagramSvg.evaluate((element) => element.outerHTML)).not.toBe(lightSvg)
  await expect(card.locator("script, foreignObject, [onload], a[href]")).toHaveCount(0)

  const downloadPromise = page.waitForEvent("download")
  await card.getByRole("button", { name: "Download PNG" }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe("mermaid-diagram.png")
  const path = await download.path()
  if (!path) throw new Error("PNG download missing")
  const png = await readFile(path)
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  await expect(card.getByText("PNG download started.")).toBeVisible()

  expect(response?.headers()["content-security-policy"]).toContain("connect-src 'self'")
  expect(externalRequests).toEqual([])
})

test("defers distant diagrams and preserves invalid source across retry", async ({ page }) => {
  await page.goto(`#/s/${token}`)
  await expect(page.locator(".diagram-card")).toHaveCount(1)
  const error = page.getByRole("alert")
  await expect(error).toContainText("This Mermaid diagram could not be rendered.")
  await error.getByText("Show diagram source").click()
  await expect(error).toContainText("Broken -->")
  await error.getByRole("button", { name: "Retry diagram" }).click()
  await expect(page.getByRole("alert")).toContainText("Broken -->")

  const waiting = page.getByLabel("Waiting to render Mermaid diagram")
  await expect(waiting).toBeAttached()
  await waiting.scrollIntoViewIfNeeded()
  await expect(page.locator(".diagram-card")).toHaveCount(2)
  await expect(
    page.locator(".diagram-card").last().getByRole("img", { name: "Mermaid diagram" }),
  ).toBeVisible()
})

for (const width of [375, 1280]) {
  test(`keeps wide and tall diagrams reachable in light and dark at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`#/s/${token}`)
    const waiting = page.getByLabel("Waiting to render Mermaid diagram").last()
    await waiting.scrollIntoViewIfNeeded()
    await expect(page.locator(".diagram-card")).toHaveCount(2)

    for (const appearance of ["Light", "Dark"] as const) {
      await page.getByRole("combobox", { name: "Theme" }).click()
      await page.getByRole("option", { name: appearance }).click()
      await expect(page.locator(`[data-appearance="${appearance.toLowerCase()}"]`)).toBeVisible()
      for (const card of await page.locator(".diagram-card").all()) {
        await card.getByRole("button", { name: /Show overview|Use readable view/ }).click()
        if (await card.getByRole("button", { name: "Show overview" }).isVisible()) {
          await card.getByRole("button", { name: "Show overview" }).click()
        }
        await expect
          .poll(async () => {
            const viewport = await card.locator(".diagram-viewport").boundingBox()
            const diagram = await card.locator(".mermaid-diagram").boundingBox()
            return Boolean(
              viewport &&
                diagram &&
                diagram.width <= viewport.width + 1 &&
                diagram.height <= viewport.height + 1,
            )
          })
          .toBe(true)
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true)
    }

    if (width === 375) {
      const sizes = await page
        .locator(".diagram-card")
        .first()
        .locator(".diagram-controls button")
        .evaluateAll((buttons) =>
          buttons.map((button) => {
            const bounds = button.getBoundingClientRect()
            return { height: bounds.height, width: bounds.width }
          }),
        )
      expect(sizes.every((size) => size.height >= 44 && size.width >= 44)).toBe(true)
    }
  })
}

test.describe("touch fullscreen fallback", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test("keeps inline touch page-safe and supports fullscreen pan and pinch", async ({
    context,
    page,
  }) => {
    await page.goto(`#/s/${token}`)
    const card = page.locator(".diagram-card").first()
    await expect(card.getByRole("img", { name: "Mermaid diagram" })).toBeVisible()
    const viewport = card.getByRole("region", { name: /Interactive Mermaid diagram/ })
    const stage = card.locator(".mermaid-diagram")
    await card.getByRole("button", { name: "Use readable view" }).click()

    const inlineTransform = await stage.getAttribute("style")
    await viewport.evaluate((element) => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: 200,
          clientY: 200,
          pointerId: 1,
          pointerType: "touch",
        }),
      )
      element.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 220,
          pointerId: 1,
          pointerType: "touch",
        }),
      )
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
        }),
      )
    })
    expect(await stage.getAttribute("style")).toBe(inlineTransform)

    const inlineBox = await viewport.boundingBox()
    if (!inlineBox) throw new Error("inline viewport missing")
    const initialScroll = await page.evaluate(() => window.scrollY)
    const cdp = await context.newCDPSession(page)
    const touchX = inlineBox.x + inlineBox.width / 2
    const touchY = inlineBox.y + Math.min(inlineBox.height - 20, 180)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchX, y: touchY }],
    })
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: touchX, y: touchY - 120 }],
    })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(initialScroll)
    expect(await stage.getAttribute("style")).toBe(inlineTransform)
    await card.scrollIntoViewIfNeeded()

    await card.evaluate((element) => {
      element.requestFullscreen = () => Promise.reject(new Error("denied for fallback test"))
    })
    const fullscreen = card.getByRole("button", { name: "Fullscreen" })
    await fullscreen.click()
    await expect(card).toHaveClass(/diagram-expanded/)
    await expect(page.locator(".theme-control")).toHaveJSProperty("inert", true)

    const beforePan = await stage.getAttribute("style")
    await viewport.evaluate((element) => {
      const pointer = (type: string, id: number, x: number, y: number) =>
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId: id,
            pointerType: "touch",
          }),
        )
      pointer("pointerdown", 1, 220, 300)
      pointer("pointermove", 1, 130, 340)
      pointer("pointerup", 1, 130, 340)
    })
    expect(await stage.getAttribute("style")).not.toBe(beforePan)

    const zoomBefore = await card.getByLabel("Current zoom").textContent()
    await viewport.evaluate((element) => {
      const pointer = (type: string, id: number, x: number, y: number) =>
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId: id,
            pointerType: "touch",
          }),
        )
      pointer("pointerdown", 1, 150, 300)
      pointer("pointerdown", 2, 250, 300)
      pointer("pointermove", 2, 320, 320)
      pointer("pointerup", 1, 150, 300)
      pointer("pointerup", 2, 320, 320)
    })
    await expect(card.getByLabel("Current zoom")).not.toHaveText(zoomBefore ?? "")

    await viewport.press("Escape")
    await expect(card).not.toHaveClass(/diagram-expanded/)
    await expect(page.locator(".theme-control")).toHaveJSProperty("inert", false)
    await expect(fullscreen).toBeFocused()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
    const sizes = await card.locator(".diagram-controls button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect()
        return { height: bounds.height, width: bounds.width }
      }),
    )
    expect(sizes.every((size) => size.height >= 44 && size.width >= 44)).toBe(true)
  })
})
