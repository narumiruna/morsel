import { describe, expect, it } from "vitest"
import { parseHash, parseRoute } from "./route"

const token = "A".repeat(43)
const gist = "7dbaf8170c7292354678069a9acb061f"

describe("parseRoute", () => {
  it.each(["login", "recover", "setup"])(
    "matches only the explicit %s authentication route",
    (mode) => {
      expect(parseRoute(`/${mode}`, "")).toEqual({ kind: "authentication", mode })
      expect(parseRoute(`/${mode}/`, "")).toEqual({ kind: "not-found" })
      expect(parseRoute(`/${mode}/unknown`, "")).toEqual({ kind: "not-found" })
      expect(parseRoute("/", `#/${mode}`)).toEqual({ kind: "not-found" })
    },
  )

  it("matches only the explicit account route", () => {
    expect(parseRoute("/account", "")).toEqual({ kind: "account" })
    expect(parseRoute("/account", "#ignored")).toEqual({ kind: "account" })
    expect(parseRoute("/account/", "")).toEqual({ kind: "not-found" })
    expect(parseRoute("/account/keys", "")).toEqual({ kind: "not-found" })
    expect(parseRoute("/v1/account", "")).toEqual({ kind: "not-found" })
    expect(parseRoute("/", "#/account")).toEqual({ kind: "not-found" })
  })

  it("matches only explicit management and example routes", () => {
    expect(parseRoute("/manage/shares", "")).toEqual({ kind: "management", section: "shares" })
    expect(parseRoute("/manage/api-keys", "")).toEqual({ kind: "management", section: "api-keys" })
    expect(parseRoute("/example", "")).toEqual({ kind: "example" })
    for (const path of [
      "/manage",
      "/manage/",
      "/manage/shares/",
      "/manage/security",
      "/example/",
    ]) {
      expect(parseRoute(path, "")).toEqual({ kind: "not-found" })
    }
    expect(parseRoute("/", "#/manage/shares")).toEqual({ kind: "not-found" })
  })

  it("parses path-based preview routes before hash routes", () => {
    expect(parseRoute(`/s/${token}`, "")).toEqual({ kind: "share", token })
    expect(parseRoute("/s/short", "")).toEqual({ kind: "invalid-share" })
    expect(parseRoute("/gist/", `#${gist}`)).toEqual({ kind: "gist", id: gist })
    expect(parseRoute("/gist/", "#not-a-gist")).toEqual({ kind: "invalid-gist" })
    expect(parseRoute(`/gist/${gist}`, "")).toEqual({ kind: "invalid-gist" })
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
