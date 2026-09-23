import DOMPurify from "dompurify"
import mermaid from "mermaid"
import type { Appearance } from "../theme"

export const maxMermaidBytes = 50 * 1024

let nextDiagramID = 0
let renderQueue: Promise<void> = Promise.resolve()

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(job, job)
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function hasUnsafeCssReference(value: string): boolean {
  if (value.includes("\\") || /@import/i.test(value)) return true
  for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    if (!match[1]?.trim().startsWith("#")) return true
  }
  return false
}

export function sanitizeMermaidSVG(svg: string): string {
  const sanitized = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "script"],
    FORBID_ATTR: ["href", "xlink:href"],
  })
  const holder = document.createElement("div")
  holder.innerHTML = sanitized
  for (const element of holder.querySelectorAll("*")) {
    if (
      element.tagName.toLowerCase() === "style" &&
      hasUnsafeCssReference(element.textContent ?? "")
    ) {
      element.remove()
      continue
    }
    for (const attribute of [...element.attributes]) {
      if (hasUnsafeCssReference(attribute.value)) element.removeAttribute(attribute.name)
    }
  }
  return holder.innerHTML
}

export function renderMermaid(source: string, appearance: Appearance): Promise<string> {
  return enqueue(async () => {
    const id = `morsel-mermaid-${++nextDiagramID}`
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        maxTextSize: maxMermaidBytes,
        theme: appearance === "dark" ? "dark" : "default",
        htmlLabels: false,
      })
      const rendered = await mermaid.render(id, source)
      return sanitizeMermaidSVG(rendered.svg)
    } finally {
      document.getElementById(id)?.remove()
    }
  })
}
