import type { Loader } from "vega"
import type { Result } from "vega-embed"
import { parseExpression } from "vega-expression"
import type { TopLevelSpec } from "vega-lite"
import type { Appearance } from "../theme"

export const maxVegaLiteBytes = 50 * 1024

const expansiveDataGenerators = ["sequence", "graticule"] as const
const expansiveTransforms = [
  "density",
  "flatten",
  "fold",
  "impute",
  "loess",
  "pivot",
  "quantile",
  "regression",
] as const
const sequenceFunctions = new Set(["sequence", "timeSequence", "utcSequence"])

function blockedResource(uri: string): Error {
  return new Error(`External resources are disabled in Vega-Lite charts: ${uri}`)
}

export const localOnlyVegaLoader: Loader = {
  load: async (uri) => Promise.reject(blockedResource(uri)),
  sanitize: async (uri) => Promise.reject(blockedResource(uri)),
  http: async (uri) => Promise.reject(blockedResource(uri)),
  file: async (uri) => Promise.reject(blockedResource(uri)),
}

type SpecContext = "data" | "spec" | "transform"

function isExpressionProperty(key: string): boolean {
  return (
    key === "calculate" ||
    key === "expr" ||
    key === "filter" ||
    key === "test" ||
    key.endsWith("Expr")
  )
}

function containsSequenceCall(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSequenceCall)
  if (!value || typeof value !== "object") return false
  const node = value as Record<string, unknown>
  if (
    node.type === "CallExpression" &&
    node.callee &&
    typeof node.callee === "object" &&
    sequenceFunctions.has((node.callee as Record<string, unknown>).name as string)
  ) {
    return true
  }
  return Object.values(node).some(containsSequenceCall)
}

function expressionGeneratesSequence(expression: string): boolean {
  try {
    return containsSequenceCall(parseExpression(expression))
  } catch {
    // Vega-Lite reports malformed expressions as render errors later.
    return false
  }
}

function validateResourceBounds(value: unknown, context: SpecContext = "spec"): void {
  if (Array.isArray(value)) {
    for (const entry of value) validateResourceBounds(entry, context)
    return
  }
  if (!value || typeof value !== "object") return

  const object = value as Record<string, unknown>
  if (
    context === "data" &&
    expansiveDataGenerators.some((property) => Object.hasOwn(object, property))
  ) {
    throw new Error("Expansive Vega-Lite data generators are disabled.")
  }
  if (
    context === "transform" &&
    expansiveTransforms.some((property) => Object.hasOwn(object, property))
  ) {
    throw new Error("Expansive Vega-Lite transforms are disabled.")
  }
  if (context === "spec" && object.impute !== null && typeof object.impute === "object") {
    throw new Error("Expansive Vega-Lite transforms are disabled.")
  }

  for (const [key, child] of Object.entries(object)) {
    // Inline data is already bounded by the chart source limit. Treat its
    // property names and string values as data rather than specification syntax.
    if (context === "data" && key === "values") continue
    if (
      typeof child === "string" &&
      isExpressionProperty(key) &&
      expressionGeneratesSequence(child)
    ) {
      throw new Error("Sequence-generating Vega expressions are disabled.")
    }
    const childContext = key === "data" ? "data" : key === "transform" ? "transform" : "spec"
    validateResourceBounds(child, childContext)
  }
}

export function parseVegaLiteSpec(source: string): TopLevelSpec {
  const value: unknown = JSON.parse(source)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A Vega-Lite specification must be a JSON object.")
  }

  // Vega-Embed reads options from top-level usermeta. Remove it so authored
  // specifications cannot override Morsel's loader and rendering policy.
  const { usermeta: _usermeta, ...spec } = value as Record<string, unknown>
  validateResourceBounds(spec)
  return spec as unknown as TopLevelSpec
}

export async function renderVegaLite(
  element: HTMLElement,
  source: string,
  appearance: Appearance,
): Promise<Result> {
  const spec = parseVegaLiteSpec(source)
  const { default: embed } = await import("vega-embed")
  return embed(element, spec, {
    actions: false,
    ast: true,
    defaultStyle: false,
    loader: localOnlyVegaLoader,
    mode: "vega-lite",
    renderer: "svg",
    theme: appearance === "dark" ? "dark" : undefined,
    tooltip: false,
  })
}
