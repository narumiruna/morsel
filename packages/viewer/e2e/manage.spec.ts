import { expect, test } from "@playwright/test"

for (const width of [1280, 375]) {
  test(`manages shares at ${width}px without storing the API key`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const key = "browser-test-key"
    const id = "11111111-1111-4111-8111-111111111111"
    const methods: string[] = []
    let revoked = false
    await page.route("**/v1/shares**", async (route) => {
      const request = route.request()
      methods.push(request.method())
      expect(request.headers().authorization).toBe(`Bearer ${key}`)
      if (request.method() === "DELETE") {
        expect(request.url()).toMatch(new RegExp(`/v1/shares/${id}$`))
        revoked = true
        await route.fulfill({ status: 204 })
        return
      }
      expect(request.url()).toContain("/v1/shares?limit=50&offset=0")
      await route.fulfill({
        json: {
          items: [
            {
              id,
              title: "Previous morsel",
              excerpt: "A".repeat(160),
              created_at: "2026-01-01T00:00:00Z",
              view_count: 0,
              max_views: 3,
              status: revoked ? "revoked" : "active",
            },
          ],
        },
      })
    })

    await page.goto("/")
    await page.getByRole("link", { name: "Manage morsels" }).click()
    await page.getByLabel("API key").fill(key)
    await page.getByRole("button", { name: "Connect" }).click()
    await expect(page.getByRole("heading", { name: "Previous morsel" })).toBeVisible()
    await expect(page.getByText("Views: 0 / 3")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    await page.getByRole("button", { name: "Revoke Previous morsel" }).click()
    const dialog = page.getByRole("alertdialog", { name: "Revoke this morsel?" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused()
    expect(methods).toEqual(["GET"])
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole("button", { name: "Revoke Previous morsel" })).toBeFocused()
    expect(methods).toEqual(["GET"])
    await page.getByRole("button", { name: "Revoke Previous morsel" }).click()
    await page.getByRole("button", { name: "Confirm revoke" }).click()
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeFocused()
    expect(methods).toEqual(["GET", "DELETE", "GET"])
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
      key,
    )
    await page.reload()
    await expect(page.getByLabel("API key")).toHaveValue("")
    await expect(page.getByRole("heading", { name: "Previous morsel" })).not.toBeVisible()
    expect(methods).toEqual(["GET", "DELETE", "GET"])
  })
}
