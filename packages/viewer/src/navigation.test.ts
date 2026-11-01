import { describe, expect, it } from "vitest"
import { authenticationURL, loginDestination } from "./navigation"

describe("authentication destinations", () => {
  it.each(["/manage/shares", "/manage/api-keys", "/manage/invitations", "/account"])(
    "accepts only the exact destination %s",
    (path) => {
      expect(loginDestination(`?next=${encodeURIComponent(path)}`)).toBe(path)
      expect(authenticationURL("recover", path)).toBe(`/recover?next=${encodeURIComponent(path)}`)
    },
  )
  it.each([
    "",
    "?next=",
    "?next=/account&next=/account",
    "?next=/account&next=",
    "?next=https://evil.example",
    "?next=//evil.example",
    "?next=/account/",
    "?next=/account?secret=x",
    "?next=/account%23secret",
    "?next=%",
    "?next=%252Faccount",
    "?next=/s/secret",
    "?next=/login",
    "?next=/manage",
    "?next=/manage/invitations/",
    "?next=/manage/invitations?token=x",
    "?next=/manage/invitations%23token=x",
    "?next=%2Faccount%00",
    "?next=%5C%5Cevil.example",
    "?next=javascript:alert(1)",
  ])("rejects missing, ambiguous, or unsafe values: %s", (search) => {
    expect(loginDestination(search)).toBe("/manage/shares")
  })
  it("preserves only the exact canonical consent destination", () => {
    const destination = `/oauth/consent?request=${"A".repeat(43)}`
    expect(loginDestination(`?next=${encodeURIComponent(destination)}`)).toBe(destination)
    for (const mode of ["login", "recover", "setup", "invite"] as const)
      expect(authenticationURL(mode, destination)).toBe(
        `/${mode}?next=${encodeURIComponent(destination)}`,
      )
  })
  it.each([
    `/oauth/consent?request=${"A".repeat(42)}B`,
    `/oauth/consent?request=${"A".repeat(43)}&extra=1`,
    `/oauth/consent?request=${"A".repeat(43)}&request=${"A".repeat(43)}`,
    `/oauth/consent?request=${"A".repeat(43)}#fragment`,
    `/oauth/consent?request=%41${"A".repeat(42)}`,
    `/oauth/consent?request=${"A".repeat(43)}%0A`,
    `/oauth/consent/?request=${"A".repeat(43)}`,
    `/oauth/consent?request=${"A".repeat(43)}\n`,
    `/oauth/authorize?request=${"A".repeat(43)}`,
    "/oauth/consent",
  ])("does not broaden continuation for %s", (destination) => {
    expect(loginDestination(`?next=${encodeURIComponent(destination)}`)).toBe("/manage/shares")
  })
  it("does not generate authentication links with arbitrary destinations", () => {
    expect(authenticationURL("login", "https://evil.example/secret")).toBe(
      "/login?next=%2Fmanage%2Fshares",
    )
  })
})
