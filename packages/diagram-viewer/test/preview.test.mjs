import { describe, expect, it } from "vitest"
import { previewURL } from "./preview.mjs"

describe("preview URL", () => {
  it("reads plain output", () => {
    expect(previewURL("Local: http://127.0.0.1:4173/\n")).toBe("http://127.0.0.1:4173/")
  })

  it("reads forced-color output used in CI", () => {
    const output =
      "\u001b[32m➜\u001b[39m \u001b[1mLocal\u001b[22m: \u001b[36mhttp://127.0.0.1:\u001b[1m44177\u001b[22m/\u001b[39m"
    expect(previewURL(output)).toBe("http://127.0.0.1:44177/")
  })

  it("waits for the rest of a split port number", () => {
    expect(previewURL("Local: http://127.0.0.1:44")).toBeUndefined()
    expect(previewURL("Local: http://127.0.0.1:44177/")).toBe("http://127.0.0.1:44177/")
  })
})
