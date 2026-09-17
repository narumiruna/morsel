import { describe, expect, it } from "vitest"
import { parseHash, parseRoute } from "./route"

const token = "A".repeat(43)

describe("parseRoute", () => {
  it("parses path-based preview routes before hash routes", () => {
    expect(parseRoute(`/s/${token}`, "")).toEqual({ kind: "share", token })
    expect(parseRoute("/s/short", "")).toEqual({ kind: "invalid-share" })
    expect(parseRoute("/unknown", "")).toEqual({ kind: "not-found" })
    expect(parseRoute("/", `#/s/${token}`)).toEqual({ kind: "share", token })
  })
})

describe("parseHash", () => {
  it("parses the root", () => {
    expect(parseHash("")).toEqual({ kind: "home" })
    expect(parseHash("#/")).toEqual({ kind: "home" })
  })

  it("parses only canonical share routes", () => {
    expect(parseHash(`#/s/${token}`)).toEqual({ kind: "share", token })
    expect(parseHash("#/s/short")).toEqual({ kind: "invalid-share" })
    expect(parseHash(`#/s/${token}/extra`)).toEqual({ kind: "invalid-share" })
  })

  it("rejects unknown routes", () => {
    expect(parseHash("#/settings")).toEqual({ kind: "not-found" })
  })
})
