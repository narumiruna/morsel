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

  it("accepts named inline datasets as data", () => {
    const spec = {
      datasets: { rows: [{ calculate: "sequence(0, 10)", value: 1 }] },
      data: { name: "rows" },
      mark: "bar",
    }

    expect(parseVegaLiteSpec(source(spec))).toEqual(spec)
  })

  it("accepts repeat compositions at the view limit", () => {
    const rows = Array.from({ length: 4 }, (_, index) => `row-${index}`)
    const columns = Array.from({ length: 5 }, (_, index) => `column-${index}`)
    const spec = { repeat: { row: rows, column: columns }, spec: { mark: "bar" } }

    expect(parseVegaLiteSpec(source(spec))).toEqual(spec)
  })

  it("rejects repeat compositions that create too many views", () => {
    const fields = Array.from({ length: 5 }, (_, index) => `field-${index}`)
    const spec = {
      repeat: { row: fields, column: fields },
      spec: { mark: "bar" },
    }

    expect(() => parseVegaLiteSpec(source(spec))).toThrow(/repeat.*limit/i)
  })

  it("accepts nested repeat compositions at the view limit", () => {
    const rows = Array.from({ length: 4 }, (_, index) => `row-${index}`)
    const columns = Array.from({ length: 5 }, (_, index) => `column-${index}`)
    const spec = {
      repeat: rows,
      spec: { repeat: columns, spec: { mark: "bar" } },
    }

    expect(parseVegaLiteSpec(source(spec))).toEqual(spec)
  })

  it("counts nested repeat compositions toward the view limit", () => {
    const fields = Array.from({ length: 5 }, (_, index) => `field-${index}`)
    const spec = {
      repeat: fields,
      spec: { repeat: fields, spec: { mark: "bar" } },
    }

    expect(() => parseVegaLiteSpec(source(spec))).toThrow(/repeat.*limit/i)
  })

  it.each(["concat", "hconcat", "vconcat"])(
    "aggregates repeated views across sibling %s compositions",
    (composition) => {
      const fields = Array.from({ length: 10 }, (_, index) => `field-${index}`)
      const repeatedSpec = { repeat: fields, spec: { mark: "bar" } }
      const atLimit = { [composition]: [repeatedSpec, repeatedSpec] }

      expect(parseVegaLiteSpec(source(atLimit))).toEqual(atLimit)
      expect(() =>
        parseVegaLiteSpec(source({ [composition]: [repeatedSpec, repeatedSpec, repeatedSpec] })),
      ).toThrow(/repeat.*limit/i)
    },
  )

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
