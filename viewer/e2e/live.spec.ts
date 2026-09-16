import { expect, test } from "@playwright/test"

const live = process.env.MORSEL_E2E_LIVE === "1"
const apiBase = "http://127.0.0.1:8080"
const apiKey = process.env.MORSEL_E2E_API_KEY ?? ""

interface CreatedShare {
  id: string
  share_url: string
}

async function createShare(
  content: string,
  options: { max_views?: number; expires_in?: number } = {},
): Promise<CreatedShare> {
  const response = await fetch(`${apiBase}/v1/shares`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content, ...options }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as CreatedShare
}

function tokenFrom(created: CreatedShare): string {
  return new URL(created.share_url).hash.replace("#/s/", "")
}

test.skip(!live, "requires the live Compose stack")

test("production viewer and API complete the release acceptance flow", async ({ page }) => {
  const rendered = await createShare(`# Live acceptance

| Feature | Result |
| --- | --- |
| GFM | pass |

$E = mc^2$

\`\`\`mermaid
graph LR
  Viewer --> API
\`\`\``)
  await page.goto(`#/s/${tokenFrom(rendered)}`)
  await expect(page.getByRole("heading", { name: "Live acceptance" })).toBeVisible()
  await expect(page.getByRole("table")).toBeVisible()
  await expect(page.locator(".katex")).toBeVisible()
  await expect(page.getByLabel("Mermaid diagram")).toBeVisible()

  const limited = await createShare("limited", { max_views: 3 })
  const limitedToken = tokenFrom(limited)
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      fetch(`${apiBase}/v1/shares/${limitedToken}`).then((response) => response.status),
    ),
  )
  expect(results.filter((status) => status === 200)).toHaveLength(3)
  expect(results.filter((status) => status === 410)).toHaveLength(7)

  const revoked = await createShare("revoke me")
  const revokeResponse = await fetch(`${apiBase}/v1/shares/${revoked.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  expect(revokeResponse.status).toBe(204)
  expect((await fetch(`${apiBase}/v1/shares/${tokenFrom(revoked)}`)).status).toBe(410)

  const expiring = await createShare("expire me", { expires_in: 1 })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const expiredResponse = await fetch(`${apiBase}/v1/shares/${tokenFrom(expiring)}`)
  expect(expiredResponse.status).toBe(410)
  await expect(expiredResponse.json()).resolves.toMatchObject({ code: "expired" })
})
