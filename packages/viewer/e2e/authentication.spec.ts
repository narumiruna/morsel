import { expect, type Page, test } from "@playwright/test"
import axe from "axe-core"

async function mockAccount(page: Page, state = { authenticated: false, setup_required: false }) {
  let fail = false
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/v1/account") {
      await route.fulfill({
        status: fail ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(fail ? { message: "Account service unavailable." } : state),
      })
    } else if (path === "/v1/account/shares") {
      await route.fulfill({ json: { items: [], matching_count: 0 } })
    } else if (path === "/v1/passkeys" || path === "/v1/api-keys") {
      await route.fulfill({ json: [] })
    } else {
      await route.fulfill({ status: 500, json: { message: "Unexpected request." } })
    }
  })
  return {
    setFailure: (value: boolean) => {
      fail = value
    },
  }
}

for (const destination of ["/manage/shares", "/manage/api-keys", "/account"]) {
  test(`signed-out ${destination} uses dedicated login and preserves history and destination`, async ({
    page,
  }) => {
    await mockAccount(page)
    await page.goto(destination)
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(destination)}$`))
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeFocused()
    await expect(page.getByRole("navigation", { name: "Management sections" })).toHaveCount(0)
    await expect(page.getByLabel("Recovery token", { exact: true })).toHaveCount(0)
    await page.reload()
    await page.getByRole("link", { name: "Recover account", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/recover\\?next=${encodeURIComponent(destination)}$`))
    await expect(page.getByRole("heading", { name: "Recover account", exact: true })).toBeFocused()
    await page.goBack()
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible()
    await page.goForward()
    await expect(page.getByLabel("Recovery token", { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole("link", { name: "Back to sign in", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(destination)}$`))
  })
}

test("setup is separate, preserves destination on refresh, and closes when the server says so", async ({
  page,
}) => {
  const state = { authenticated: false, setup_required: true }
  await mockAccount(page, state)
  await page.goto("/recover?next=%2Fmanage%2Fapi-keys")
  await expect(page).toHaveURL(/\/setup\?next=%2Fmanage%2Fapi-keys$/)
  await expect(page.getByLabel("Setup token", { exact: true })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Management sections" })).toHaveCount(0)
  await page.reload()
  await expect(page.getByLabel("Setup token", { exact: true })).toBeVisible()
  state.setup_required = false
  await page.reload()
  await expect(page).toHaveURL(/\/login\?next=%2Fmanage%2Fapi-keys$/)
  await expect(page.getByLabel("Setup token", { exact: true })).toHaveCount(0)
})

test("account failures show retry rather than login and recover without losing the destination", async ({
  page,
}) => {
  const mock = await mockAccount(page)
  mock.setFailure(true)
  await page.goto("/account")
  await expect(page.getByRole("alert")).toHaveText("Account service unavailable.")
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toHaveCount(0)
  mock.setFailure(false)
  await page.getByRole("button", { name: "Retry account" }).click()
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/)
})

test("authenticated authentication routes honor only safe destinations", async ({ page }) => {
  await mockAccount(page, { authenticated: true, setup_required: false })
  for (const mode of ["login", "recover", "setup"]) {
    await page.goto(`/${mode}?next=%2Faccount`)
    await expect(page).toHaveURL(/\/account$/)
    await expect(page.getByRole("heading", { name: "Passkeys", exact: true })).toBeVisible()
  }
  for (const query of ["next=https://evil.example", "next=/account&next=/account", "next=%"]) {
    await page.goto(`/login?${query}`)
    await expect(page).toHaveURL(/\/manage\/shares$/)
    await expect(page.getByRole("heading", { name: "Shares", exact: true })).toBeVisible()
  }
})

for (const mode of ["login", "recover", "setup"]) {
  test(`${mode} is accessible and usable at 320px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await mockAccount(page, { authenticated: false, setup_required: mode === "setup" })
    await page.goto(`/${mode}`)
    const title =
      mode === "login" ? "Sign in" : mode === "recover" ? "Recover account" : "Set up account"
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeFocused()
    await page.keyboard.press("Tab")
    if (mode === "login") {
      await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeFocused()
    } else {
      await expect(
        page.getByLabel(mode === "setup" ? "Setup token" : "Recovery token", { exact: true }),
      ).toBeFocused()
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    await page.evaluate(axe.source)
    const violations = await page.evaluate(async () => {
      const browserAxe = (window as unknown as { axe: typeof axe }).axe
      return (
        await browserAxe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations
    })
    expect(violations).toEqual([])
  })
}
