import { ExclamationTriangleIcon } from "@radix-ui/react-icons"
import { Callout } from "@radix-ui/themes"
import DOMPurify from "dompurify"
import mermaid from "mermaid"
import { useEffect, useState } from "react"
import { DiagramViewer } from "./DiagramViewer"

export const maxMermaidDiagrams = 20
export const maxMermaidBytes = 50 * 1024

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  maxTextSize: maxMermaidBytes,
  theme: "neutral",
  htmlLabels: false,
})

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

function sanitizeSVG(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "script"],
    FORBID_ATTR: ["href", "xlink:href"],
  })
}

function DiagramError({ message, source }: { message: string; source: string }) {
  return (
    <Callout.Root color="red" role="alert" className="diagram-error">
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <div>
        <p>{message}</p>
        <details>
          <summary>Show diagram source</summary>
          <pre>
            <code>{source}</code>
          </pre>
        </details>
      </div>
    </Callout.Root>
  )
}

export function MermaidDiagram({ source, index }: { source: string; index: number }) {
  const [svg, setSVG] = useState<string>()
  const [error, setError] = useState<string>()
  const byteLength = new TextEncoder().encode(source).byteLength

  useEffect(() => {
    if (index >= maxMermaidDiagrams || byteLength > maxMermaidBytes) return
    let active = true
    const id = `morsel-mermaid-${++nextDiagramID}`
    void enqueue(async () => {
      const rendered = await mermaid.render(id, source)
      return sanitizeSVG(rendered.svg)
    }).then(
      (safeSVG) => {
        if (active) setSVG(safeSVG)
      },
      () => {
        if (active) setError("This Mermaid diagram could not be rendered.")
      },
    )
    return () => {
      active = false
      document.getElementById(id)?.remove()
    }
  }, [byteLength, index, source])

  if (index >= maxMermaidDiagrams) {
    return (
      <DiagramError
        message={`Only the first ${maxMermaidDiagrams} diagrams are rendered.`}
        source={source}
      />
    )
  }
  if (byteLength > maxMermaidBytes) {
    return <DiagramError message="This diagram exceeds the 50 KiB source limit." source={source} />
  }
  if (error) return <DiagramError message={error} source={source} />
  if (!svg)
    return <div className="diagram-loading" role="status" aria-label="Rendering Mermaid diagram" />
  return <DiagramViewer key={source} svg={svg} source={source} />
}
