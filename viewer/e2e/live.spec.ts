import { expect, test } from "@playwright/test"

const live = process.env.MORSEL_E2E_LIVE === "1"
const apiBase = process.env.MORSEL_E2E_API_BASE ?? "http://127.0.0.1:12647"
const apiKey = process.env.MORSEL_E2E_API_KEY ?? ""

interface PreviewMetadata {
  title: string
  description: string
}

interface CreatedShare {
  id: string
  share_url: string
  preview?: PreviewMetadata
}

async function createShare(
  content: string,
  options: { max_views?: number; expires_in?: number; preview?: PreviewMetadata } = {},
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
  const url = new URL(created.share_url)
  return url.hash ? url.hash.replace("#/s/", "") : url.pathname.replace("/s/", "")
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

  const preview = {
    title: 'Telegram "preview"',
    description: "A safe <summary> & details.",
  }
  const previewed = await createShare("# Document content must not become metadata", {
    max_views: 1,
    preview,
  })
  expect(previewed.preview).toEqual(preview)
  const previewResponse = await fetch(previewed.share_url)
  expect(previewResponse.status).toBe(200)
  const previewHTML = await previewResponse.text()
  expect(previewHTML).toContain('property="og:title" content="Telegram &#34;preview&#34;"')
  expect(previewHTML).toContain(
    'property="og:description" content="A safe &lt;summary&gt; &amp; details."',
  )
  expect(previewHTML).not.toContain("Document content must not become metadata")
  expect((await fetch(`${apiBase}/v1/shares/${tokenFrom(previewed)}`)).status).toBe(200)
  expect((await fetch(`${apiBase}/v1/shares/${tokenFrom(previewed)}`)).status).toBe(410)

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
