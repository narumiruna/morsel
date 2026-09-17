import { describe, expect, it } from "vitest"
import { parseVegaLiteSpec } from "./vegaLiteRenderer"

function source(spec: Record<string, unknown>): string {
  return JSON.stringify(spec)
}

describe("parseVegaLiteSpec", () => {
  it("accepts inline values as data and strips authored embed options", () => {
    const spec = parseVegaLiteSpec(
      source({
        usermeta: { embedOptions: { actions: true } },
        data: { values: [{ sequence: "a field value", value: 1 }] },
        mark: "bar",
      }),
    )

    expect(spec).not.toHaveProperty("usermeta")
    expect(spec).toMatchObject({
      data: { values: [{ sequence: "a field value", value: 1 }] },
      mark: "bar",
    })
  })

  it.each([
    ["sequence data", { data: { sequence: { start: 0, stop: 1_000_000_000 } } }],
    ["nested graticule data", { layer: [{ data: { graticule: { precision: 1e-12 } } }] }],
    ["density transform", { transform: [{ density: "value", steps: 1_000_000_000 }] }],
    ["flatten transform", { transform: [{ flatten: ["items"] }] }],
    ["fold transform", { transform: [{ fold: ["a", "b"] }] }],
    ["impute transform", { transform: [{ impute: "value", key: "key" }] }],
    [
      "encoding impute",
      { encoding: { y: { field: "value", impute: { keyvals: { stop: 1e9 } } } } },
    ],
    ["loess transform", { transform: [{ loess: "value", on: "key" }] }],
    ["pivot transform", { transform: [{ pivot: "key", value: "value" }] }],
    ["quantile transform", { transform: [{ quantile: "value", step: 1e-12 }] }],
    ["regression transform", { transform: [{ regression: "value", on: "key", order: 1e9 }] }],
    [
      "sequence expression",
      { transform: [{ calculate: "sequence (0, 1000000000)", as: "values" }] },
    ],
    [
      "time sequence expression",
      { params: [{ name: "dates", expr: "utcSequence('day', 0, 1e15)" }] },
    ],
  ])("rejects %s before Vega can execute it", (_name, spec) => {
    expect(() => parseVegaLiteSpec(source(spec))).toThrow(/disabled/i)
  })
})
