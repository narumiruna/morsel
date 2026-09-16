import { Button } from "@radix-ui/themes"
import { useEffect, useId, useRef, useState } from "react"

export function DiagramViewer({ svg, source }: { svg: string; source: string }) {
  const card = useRef<HTMLDivElement>(null)
  const sourceID = useId()
  const [zoom, setZoom] = useState(100)
  const [showSource, setShowSource] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [status, setStatus] = useState("")

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === card.current)
    document.addEventListener("fullscreenchange", update)
    return () => document.removeEventListener("fullscreenchange", update)
  }, [])

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setStatus("Copied to clipboard.")
    } catch {
      setStatus("Copy failed. Check clipboard permissions.")
    }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === card.current) await document.exitFullscreen()
      else await card.current?.requestFullscreen()
    } catch {
      setStatus("Fullscreen is not available in this browser.")
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "mermaid-diagram.svg"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="diagram-card" ref={card}>
      <fieldset className="diagram-controls" aria-label="Diagram controls">
        <Button
          variant="soft"
          disabled={showSource || zoom <= 25}
          onClick={() => setZoom(Math.max(25, zoom - 25))}
        >
          Zoom out
        </Button>
        <output aria-label="Current zoom">{zoom}%</output>
        <Button
          variant="soft"
          disabled={showSource || zoom >= 400}
          onClick={() => setZoom(Math.min(400, zoom + 25))}
        >
          Zoom in
        </Button>
        <Button variant="soft" disabled={showSource} onClick={() => setZoom(100)}>
          Reset zoom
        </Button>
        <Button variant="soft" onClick={toggleFullscreen}>
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </Button>
        <Button
          variant="soft"
          aria-controls={sourceID}
          aria-pressed={showSource}
          onClick={() => setShowSource(!showSource)}
        >
          {showSource ? "Show diagram" : "Show source"}
        </Button>
        <Button variant="soft" onClick={() => copy(source)}>
          Copy source
        </Button>
        <Button variant="soft" onClick={() => copy(svg)}>
          Copy SVG
        </Button>
        <Button variant="soft" onClick={download}>
          Download SVG
        </Button>
      </fieldset>
      <div className="diagram-viewport" hidden={showSource}>
        <div
          className="mermaid-diagram"
          role="img"
          aria-label="Mermaid diagram"
          style={{ width: `${zoom}%` }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG is sanitized by MermaidDiagram before insertion.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <pre id={sourceID} hidden={!showSource}>
        <code>{source}</code>
      </pre>
      <div className="diagram-status" role="status">
        {status}
      </div>
    </div>
  )
}
