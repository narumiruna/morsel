import { expect, type Locator, type Page, test } from "@playwright/test"
import axe from "axe-core"

function defaultCard(page: Page) {
  return page.locator(".default-viewer")
}

async function openFixture(page: Page, query = "") {
  await page.goto(`/${query}`)
  await expect(
    defaultCard(page).getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeEnabled()
  await expect(
    page.locator(".live-viewer").getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeEnabled()
  await expect(defaultCard(page).locator(".ndv-stage")).not.toHaveCSS("transform", "none")
}

async function transform(card: Locator) {
  return card.locator(".ndv-stage").evaluate((element) => getComputedStyle(element).transform)
}

async function checkAccessibility(page: Page, selector: string) {
  await page.evaluate(axe.source)
  const violations = await page.evaluate(async (scope) => {
    const browserAxe = (window as unknown as { axe: typeof axe }).axe
    const result = await browserAxe.run(scope, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
    })
    return result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    }))
  }, selector)
  expect(violations).toEqual([])
}

for (const kind of ["sequence", "class"]) {
  for (const theme of ["light", "dark"]) {
    for (const width of [380, 1280]) {
      test(`${kind}: ${theme}, ${width}px standalone layout and accessibility`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme === "dark" ? "dark" : "light" })
        await openFixture(page, `?kind=${kind}&theme=${theme}`)
        for (const name of ["default", "custom"]) {
          const card = page.locator(`.${name}-viewer`)
          const bounds = await card.boundingBox()
          expect(bounds).not.toBeNull()
          expect(bounds?.width).toBeLessThanOrEqual(width)
          const controlsFit = await card.locator("button").evaluateAll((buttons) =>
            buttons.every((button) => {
              const cardRect = button.closest(".ndv-root")?.getBoundingClientRect()
              const rect = button.getBoundingClientRect()
              return (
                cardRect &&
                rect.left >= cardRect.left &&
                rect.right <= cardRect.right &&
                rect.width >= 24 &&
                rect.height >= 24
              )
            }),
          )
          expect(controlsFit).toBe(true)
          await card.screenshot({
            path: testInfo.outputPath(`${kind}-${theme}-${width}-${name}-inline.png`),
          })
          await checkAccessibility(page, `.${name}-viewer`)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
        await expect(defaultCard(page)).toHaveCSS(
          "background-color",
          theme === "dark" ? "rgb(23, 33, 47)" : "rgb(255, 255, 255)",
        )
      })
    }
  }
}

test("default controls and custom native button share actions without shared instance state", async ({
  page,
}) => {
  const requests: string[] = []
  page.on("request", (request) => requests.push(request.url()))
  await openFixture(page)
  const first = defaultCard(page)
  const custom = page.locator(".custom-viewer")
  const names = await first
    .locator("fieldset button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))
  expect(names).toEqual([
    "Zoom out",
    "Zoom in",
    "Fit to screen",
    "Reset zoom",
    "Fullscreen",
    "Show source",
    "Copy source",
    "Download SVG",
    "Download PNG",
  ])
  await expect(custom.getByRole("toolbar")).toHaveCount(0)
  await expect(custom.getByRole("group", { name: "Custom diagram controls" })).toHaveCount(1)
  expect(
    await custom
      .locator("fieldset button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
      ),
  ).toEqual(["Show source", "Pin diagram", "Zoom in", "Fit to screen", "Fullscreen"])
  await expect(custom.getByRole("button", { name: "Download PNG" })).toHaveCount(0)
  await expect(custom.locator(".app-fit")).toHaveText("⤢")
  await expect(custom.locator(".app-fit svg")).toHaveCount(0)
  await expect(custom).toHaveCSS("border-radius", "14px")
  await expect(custom.locator(".app-fit")).toHaveCSS("background-color", "rgb(216, 244, 231)")
  const firstZoom = await first.getByLabel("Current zoom").textContent()
  const customZoom = await custom.getByLabel("Current zoom").textContent()
  await custom.getByRole("button", { name: "Zoom in", exact: true }).click()
  await expect(custom.getByLabel("Current zoom")).not.toHaveText(customZoom ?? "")
  await expect(first.getByLabel("Current zoom")).toHaveText(firstZoom ?? "")
  await custom.getByRole("button", { name: "Pin diagram" }).click()
  await expect(custom.getByRole("button", { name: "Pin diagram" })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await custom.getByRole("button", { name: "Show source" }).focus()
  await page.keyboard.press("Tab")
  await expect(custom.getByRole("button", { name: "Pin diagram" })).toBeFocused()
  const before = await transform(custom)
  await page.keyboard.press("ArrowRight")
  await expect(custom.getByRole("button", { name: "Pin diagram" })).toBeFocused()
  expect(await transform(custom)).toBe(before)
  await page.keyboard.press("Tab")
  await expect(custom.getByRole("button", { name: "Zoom in", exact: true })).toBeFocused()
  const beforeEnterZoom = await custom.getByLabel("Current zoom").textContent()
  await page.keyboard.press("Enter")
  await expect(custom.getByLabel("Current zoom")).not.toHaveText(beforeEnterZoom ?? "")
  const sourceIDs = await page
    .locator(".ndv-source")
    .evaluateAll((elements) => elements.map((element) => element.id))
  expect(new Set(sourceIDs).size).toBe(sourceIDs.length)
  expect(requests.some((url) => /diagram-viewer\/dist\/index\.js/.test(url))).toBe(true)
  expect(requests.some((url) => /radix|packages\/viewer\/|diagram-viewer\/src\//i.test(url))).toBe(
    false,
  )
  expect(
    await page
      .locator("style[data-vite-dev-id]")
      .evaluateAll((styles) => styles.map((style) => style.getAttribute("data-vite-dev-id"))),
  ).toEqual([expect.stringMatching(/diagram-viewer\/dist\/styles\.css$/)])
})

test("source stays text, scrolls independently, and copy and exports use package actions", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await openFixture(page)
  const card = defaultCard(page)
  const sourceButton = card.getByRole("button", { name: "Show source", exact: true })
  const sourceID = await sourceButton.getAttribute("aria-controls")
  await sourceButton.click()
  const source = card.getByRole("region", { name: "Diagram source", exact: true })
  await expect(source).toHaveAttribute("id", sourceID ?? "")
  await expect(source).toContainText('<img src=x onerror="window.sourceExecuted=true">')
  await expect(source.locator("img")).toHaveCount(0)
  await expect(card.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled()
  const before = await transform(card)
  await source.focus()
  await page.keyboard.press("End")
  await page.keyboard.press("PageDown")
  await expect.poll(() => source.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await transform(card)).toBe(before)
  await card.getByRole("button", { name: "Copy source", exact: true }).click()
  await expect(card.locator(".ndv-status")).toHaveText("Copied to clipboard.")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await source.textContent())
  await card.getByRole("button", { name: "Show diagram", exact: true }).click()
  for (const extension of ["svg", "png"]) {
    const downloaded = page.waitForEvent("download")
    await card
      .getByRole("button", { name: `Download ${extension.toUpperCase()}`, exact: true })
      .click()
    const download = await downloaded
    expect(download.suggestedFilename()).toBe(`standalone-document.${extension}`)
    await download.saveAs(testInfo.outputPath(download.suggestedFilename()))
    await expect(card.locator(".ndv-status")).toHaveText(
      `${extension.toUpperCase()} download started.`,
    )
  }
  await checkAccessibility(page, ".default-viewer")
})

test("dynamic SVG replacement refreshes dimensions and keeps instance controls usable", async ({
  page,
}, testInfo) => {
  await openFixture(page)
  const card = defaultCard(page)
  await card.getByRole("button", { name: "Zoom in", exact: true }).click()
  await card.screenshot({ path: testInfo.outputPath("before-replacement.png") })
  await page.getByRole("button", { name: "Replace SVG", exact: true }).click()
  await expect(card.locator(".ndv-stage > svg")).toHaveAttribute("viewBox", "0 0 800 400")
  await card.getByRole("button", { name: "Fit to screen", exact: true }).click()
  const fitted = await transform(card)
  await card.getByRole("button", { name: "Zoom in", exact: true }).click()
  await expect.poll(() => transform(card)).not.toBe(fitted)
  await card.getByRole("button", { name: "Reset zoom", exact: true }).click()
  await card.getByRole("button", { name: "Show source", exact: true }).click()
  await expect(card.getByRole("region", { name: "Diagram source", exact: true })).toContainText(
    "classDiagram",
  )
  await card.getByRole("button", { name: "Show diagram", exact: true }).click()
  await card.screenshot({ path: testInfo.outputPath("after-replacement.png") })
})

test("native fullscreen keeps the live SVG and tooltip inside the card and restores focus", async ({
  page,
}, testInfo) => {
  await openFixture(page)
  const card = defaultCard(page)
  const svg = await card.locator(".ndv-stage > svg").elementHandle()
  const opener = card.getByRole("button", { name: "Fullscreen", exact: true })
  await opener.click()
  await expect
    .poll(() => card.evaluate((element) => document.fullscreenElement === element))
    .toBe(true)
  await expect(card).not.toHaveClass(/diagram-expanded/)
  await expect(card.getByRole("button", { name: "Exit fullscreen", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await card.getByRole("button", { name: "Zoom in", exact: true }).focus()
  const tooltip = card.getByRole("tooltip", { name: "Zoom in", exact: true })
  await expect(tooltip).toBeVisible()
  expect(await tooltip.evaluate((element) => document.fullscreenElement?.contains(element))).toBe(
    true,
  )
  const tooltipBounds = await tooltip.boundingBox()
  expect(tooltipBounds?.y).toBeGreaterThanOrEqual(0)
  expect((tooltipBounds?.y ?? 0) + (tooltipBounds?.height ?? 0)).toBeLessThanOrEqual(900)
  await card.screenshot({ path: testInfo.outputPath("native-fullscreen-tooltip.png") })
  expect(
    await card
      .locator(".ndv-stage > svg")
      .evaluate((element, original) => element === original, svg),
  ).toBe(true)
  await card.getByRole("button", { name: "Exit fullscreen", exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull()
  await expect(opener).toBeFocused()
})

for (const mode of ["unavailable", "rejected"]) {
  test(`fullscreen ${mode} falls back, restores isolation and scroll, and cleans up on unmount`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((failureMode) => {
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
        configurable: true,
        value:
          failureMode === "unavailable"
            ? undefined
            : () => Promise.reject(new Error("Fullscreen denied")),
      })
      document.addEventListener("DOMContentLoaded", () => {
        document.body.style.overflow = "auto"
        document.documentElement.style.overscrollBehavior = "contain"
      })
    }, mode)
    await openFixture(page)
    const card = defaultCard(page)
    const opener = card.getByRole("button", { name: "Fullscreen", exact: true })
    await opener.click()
    await expect(card).toHaveAttribute("role", "dialog")
    await expect(card).toHaveAttribute("aria-modal", "true")
    await expect(page.locator(".custom-viewer")).toHaveJSProperty("inert", false)
    expect(
      await page
        .locator(".custom-viewer")
        .evaluate((element) => Boolean(element.closest("[inert]"))),
    ).toBe(true)
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden")
    await card.getByRole("button", { name: "Fit to screen", exact: true }).focus()
    await expect(card.getByRole("tooltip", { name: "Fit to screen", exact: true })).toBeVisible()
    await card.screenshot({ path: testInfo.outputPath(`fallback-${mode}-tooltip.png`) })
    await checkAccessibility(page, ".default-viewer")
    await page.keyboard.press("Escape")
    await expect(card).not.toHaveAttribute("role", "dialog")
    await expect(opener).toBeFocused()
    await expect(page.locator("body")).toHaveCSS("overflow", "auto")
    await expect(page.locator("html")).toHaveCSS("overscroll-behavior", "contain")
    expect(
      await page
        .locator(".custom-viewer")
        .evaluate((element) => Boolean(element.closest("[inert]"))),
    ).toBe(false)
    await opener.click()
    await expect(card).toHaveAttribute("role", "dialog")
    // Simulate host-driven removal while background UI is correctly inert.
    await page
      .getByRole("button", { name: "Unmount viewers", includeHidden: true })
      .evaluate((element: HTMLButtonElement) => element.click())
    await expect(page.locator(".ndv-root")).toHaveCount(0)
    await expect(page.locator("[inert]")).toHaveCount(0)
    await expect(page.locator("body")).toHaveCSS("overflow", "auto")
    await page.getByRole("button", { name: "Mount viewers", exact: true }).click()
    await expect(
      defaultCard(page).getByRole("button", { name: "Zoom in", exact: true }),
    ).toBeEnabled()
  })
}

test("fallback restores host scroll longhands and priorities on exit and unmount", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: undefined,
    })
  })
  await openFixture(page)
  await page.addStyleTag({ content: "main { height: 450px; overflow: hidden; }" })
  await page.locator("main").evaluate((element) => {
    element.style.setProperty("overflow-y", "auto", "important")
    element.style.setProperty("overscroll-behavior-y", "contain", "important")
    document.body.style.setProperty("overflow-x", "scroll", "important")
    document.body.style.setProperty("overflow-y", "auto")
    document.documentElement.style.setProperty("overscroll-behavior-x", "none", "important")
  })
  const snapshot = () =>
    page.evaluate(() =>
      [document.querySelector("main"), document.body, document.documentElement].map((element) => {
        if (!(element instanceof HTMLElement)) throw new Error("Missing scroll container")
        return ["overflow-x", "overflow-y", "overscroll-behavior-x", "overscroll-behavior-y"].map(
          (property) => ({
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          }),
        )
      }),
    )
  const before = await snapshot()
  const card = defaultCard(page)
  await card.getByRole("button", { name: "Fullscreen", exact: true }).click()
  await expect(card).toHaveAttribute("role", "dialog")
  await page.keyboard.press("Escape")
  await expect(card).not.toHaveAttribute("role", "dialog")
  expect(await snapshot()).toEqual(before)
  await expect(page.locator("main")).toHaveCSS("overflow-y", "auto")
  await page.locator("main").evaluate((element) => {
    element.scrollTop = 0
  })
  await page.locator("main").hover({ position: { x: 4, y: 4 } })
  await page.mouse.wheel(0, 80)
  await expect
    .poll(() => page.locator("main").evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  await card.getByRole("button", { name: "Fullscreen", exact: true }).click()
  await expect(card).toHaveAttribute("role", "dialog")
  await page
    .getByRole("button", { name: "Unmount viewers", includeHidden: true })
    .evaluate((element: HTMLButtonElement) => element.click())
  await expect(page.locator(".ndv-root")).toHaveCount(0)
  expect(await snapshot()).toEqual(before)
  await expect(page.locator("main")).toHaveCSS("overflow-y", "auto")
})

test("imperative Vega mount and native chart controls survive toolbar and content updates", async ({
  page,
}, testInfo) => {
  await openFixture(page)
  const card = page.locator(".live-viewer")
  const svg = await card.locator(".ndv-stage svg").elementHandle()
  const input = card.getByRole("slider", { name: "Minimum amount", exact: true })
  const originalInput = await input.elementHandle()
  await expect(input).toHaveValue("0")
  await input.focus()
  const camera = await transform(card)
  await page.keyboard.press("ArrowRight")
  await expect(input).toHaveValue("1")
  expect(await transform(card)).toBe(camera)
  await card.getByRole("button", { name: "Zoom in", exact: true }).click()
  await card.getByRole("button", { name: "Fit to screen", exact: true }).click()
  await card.getByRole("button", { name: "Show source", exact: true }).click()
  await card.getByRole("button", { name: "Show chart", exact: true }).click()
  await card.getByRole("button", { name: "Fullscreen", exact: true }).click()
  await expect(card.getByRole("button", { name: "Exit fullscreen", exact: true })).toBeEnabled()
  await input.focus()
  await page.keyboard.press("ArrowRight")
  await expect(input).toHaveValue("2")
  await card.screenshot({ path: testInfo.outputPath("live-chart-fullscreen.png") })
  await card.getByRole("button", { name: "Exit fullscreen", exact: true }).click()
  await page.getByRole("button", { name: "Update chart data", exact: true }).click()
  await expect(card.locator(".ndv-stage svg")).toContainText("C")
  expect(
    await card.locator(".ndv-stage svg").evaluate((element, original) => element === original, svg),
  ).toBe(true)
  expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(
    true,
  )
  await expect(input).toHaveValue("2")
  await card.screenshot({ path: testInfo.outputPath("live-chart-after-update.png") })
  await checkAccessibility(page, ".live-viewer")
})
