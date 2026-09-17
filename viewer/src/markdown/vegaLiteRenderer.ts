import type { Loader } from "vega"
import type { Result } from "vega-embed"
import type { TopLevelSpec } from "vega-lite"
import type { Appearance } from "../theme"

export const maxVegaLiteBytes = 50 * 1024

function blockedResource(uri: string): Error {
  return new Error(`External resources are disabled in Vega-Lite charts: ${uri}`)
}

export const localOnlyVegaLoader: Loader = {
  load: async (uri) => Promise.reject(blockedResource(uri)),
  sanitize: async (uri) => Promise.reject(blockedResource(uri)),
  http: async (uri) => Promise.reject(blockedResource(uri)),
  file: async (uri) => Promise.reject(blockedResource(uri)),
}

function parseSpec(source: string): TopLevelSpec {
  const value: unknown = JSON.parse(source)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A Vega-Lite specification must be a JSON object.")
  }

  // Vega-Embed reads options from top-level usermeta. Remove it so authored
  // specifications cannot override Morsel's loader and rendering policy.
  const { usermeta: _usermeta, ...spec } = value as Record<string, unknown>
  return spec as unknown as TopLevelSpec
}

export async function renderVegaLite(
  element: HTMLElement,
  source: string,
  appearance: Appearance,
): Promise<Result> {
  const spec = parseSpec(source)
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
