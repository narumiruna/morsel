import { describe, expect, it } from "vitest"
import { formatDate } from "./formatDate"

describe("formatDate", () => {
  it("uses an explicit English format and UTC independent of the browser locale", () => {
    expect(formatDate("2026-10-22T09:41:23Z")).toBe("22 Oct 2026, 09:41:23 UTC")
    expect(formatDate("2026-10-22T17:41:23+08:00")).toBe("22 Oct 2026, 09:41:23 UTC")
  })

  it("does not display invalid date input", () => {
    expect(formatDate("invalid")).toBe("Unknown date")
  })
})
