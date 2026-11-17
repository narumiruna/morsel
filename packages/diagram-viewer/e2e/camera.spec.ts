import { expect, type Page, test } from "@playwright/test"

test.use({ hasTouch: true, viewport: { width: 600, height: 800 } })

async function openCamera(page: Page, expanded = true) {
  await page.goto("/camera.html")
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true")
  if (expanded) await page.getByRole("button", { name: "Expand", exact: true }).click()
  const session = await page.context().newCDPSession(page)
  return async (
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    points: number[][],
  ) => {
    await session.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([id, x, y]) => ({ id, x, y })),
    })
  }
}

async function cameraTransform(page: Page) {
  return page.locator("#stage").evaluate((element) => getComputedStyle(element).transform)
}

test("expanded node tap activates; drag pans without activation, then keyboard and tap still work", async ({
  page,
}) => {
  const touch = await openCamera(page)
  await touch("touchStart", [[1, 280, 100]])
  await touch("touchEnd", [])
  await expect(page.locator("body")).toHaveAttribute("data-selections", "1")
  const before = await cameraTransform(page)
  await touch("touchStart", [[1, 280, 100]])
  await touch("touchMove", [[1, 180, 100]])
  await touch("touchEnd", [])
  expect(await cameraTransform(page)).not.toBe(before)
  await expect(page.locator("body")).toHaveAttribute("data-selections", "1")
  await page.getByRole("button", { name: "Select node", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator("body")).toHaveAttribute("data-selections", "2")
  await page.keyboard.press("Space")
  await expect(page.locator("body")).toHaveAttribute("data-selections", "3")
  await touch("touchStart", [[1, 180, 100]])
  await touch("touchEnd", [])
  await expect(page.locator("body")).toHaveAttribute("data-selections", "4")
})

test("node pinch changes scale; cancellation permits next tap and nested controls stay native", async ({
  page,
}) => {
  const touch = await openCamera(page)
  const before = await cameraTransform(page)
  await touch("touchStart", [
    [1, 180, 100],
    [2, 280, 100],
  ])
  await touch("touchMove", [
    [1, 130, 100],
    [2, 330, 100],
  ])
  expect(await cameraTransform(page)).not.toBe(before)
  await touch("touchCancel", [])
  await touch("touchStart", [[1, 180, 100]])
  await touch("touchEnd", [])
  await expect(page.locator("body")).toHaveAttribute("data-selections", "1")
  const camera = await cameraTransform(page)
  const control = page.getByRole("button", { name: "Nested control", exact: true })
  await control.tap()
  await expect(page.locator("body")).toHaveAttribute("data-control", "activated")
  expect(await cameraTransform(page)).toBe(camera)
  const bounds = await control.boundingBox()
  if (!bounds) throw new Error("Missing control bounds")
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await touch("touchStart", [[1, x, y]])
  await touch("touchMove", [[1, x + 20, y]])
  await touch("touchEnd", [])
  expect(await cameraTransform(page)).toBe(camera)
})

test("touch compatibility PointerEvent clicks are suppressed without swallowing later mouse or keyboard activation", async ({
  page,
}) => {
  await openCamera(page)
  const prevented = await page.locator("[data-diagram-node]").evaluate((node) => {
    for (const [type, x] of [
      ["pointerdown", 280],
      ["pointermove", 180],
      ["pointerup", 180],
    ] as const) {
      node.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 7,
          pointerType: "touch",
          clientX: x,
          clientY: 100,
        }),
      )
    }
    const event = new PointerEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
      pointerId: 7,
      pointerType: "touch",
    })
    node.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(prevented).toBe(true)
  await expect(page.locator("body")).toHaveAttribute("data-selections", "0")
  await page.mouse.click(180, 100)
  await expect(page.locator("body")).toHaveAttribute("data-selections", "1")
  await page.getByRole("button", { name: "Select node", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator("body")).toHaveAttribute("data-selections", "2")
  await page.keyboard.press("Space")
  await expect(page.locator("body")).toHaveAttribute("data-selections", "3")
})

test("readable camera measures small HTML-only SVG labels", async ({ page }) => {
  await openCamera(page, false)
  await page.locator("[data-diagram-node]").evaluate((node) => {
    node.innerHTML =
      '<foreignObject width="200" height="100"><div xmlns="http://www.w3.org/1999/xhtml"><p style="font-size: 10px"><span style="font-size: 8px">Small label</span></p></div></foreignObject>'
  })
  await page.getByRole("button", { name: "Readable view", exact: true }).click()
  const metrics = await page.locator("#stage").evaluate((stage) => {
    const label = stage.querySelector("foreignObject span")
    if (!label) throw new Error("Missing HTML label")
    const scale = new DOMMatrix(getComputedStyle(stage).transform).a
    return { scale, labelPixels: Number.parseFloat(getComputedStyle(label).fontSize) * scale }
  })
  expect(metrics).toEqual({ scale: 1.75, labelPixels: 14 })
})

test("inline node touch scrolls the page without moving the camera", async ({ page }) => {
  const touch = await openCamera(page, false)
  const before = await cameraTransform(page)
  await touch("touchStart", [[1, 280, 100]])
  await touch("touchMove", [[1, 280, 60]])
  await touch("touchMove", [[1, 280, 30]])
  await touch("touchEnd", [])
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0)
  expect(await cameraTransform(page)).toBe(before)
})

test("destroy releases active capture and all camera behavior", async ({ page }) => {
  const touch = await openCamera(page)
  await touch("touchStart", [[1, 280, 100]])
  await touch("touchMove", [[1, 180, 100]])
  await page
    .getByRole("button", { name: "Destroy", exact: true })
    .evaluate((element: HTMLButtonElement) => element.click())
  const before = await cameraTransform(page)
  await touch("touchMove", [[1, 80, 100]])
  await touch("touchEnd", [])
  expect(await cameraTransform(page)).toBe(before)
  await page.getByRole("button", { name: "Select node", exact: true }).tap()
  await expect(page.locator("body")).toHaveAttribute("data-selections", "1")
})
