import {
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  EnterFullScreenIcon,
  ExitFullScreenIcon,
  EyeOpenIcon,
  MinusIcon,
  PlusIcon,
  ResetIcon,
} from "@radix-ui/react-icons"
import * as Tooltip from "@radix-ui/react-tooltip"
import { useEffect, useId, useRef, useState } from "react"
import { ActionButton } from "../components/ActionButton"

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
      <Tooltip.Provider delayDuration={350}>
        <fieldset className="diagram-controls" aria-label="Diagram controls">
          <ActionButton
            className="diagram-control"
            label="Zoom out"
            variant="soft"
            disabled={showSource || zoom <= 25}
            onClick={() => setZoom(Math.max(25, zoom - 25))}
          >
            <MinusIcon />
          </ActionButton>
          <output aria-label="Current zoom">{zoom}%</output>
          <ActionButton
            className="diagram-control"
            label="Zoom in"
            variant="soft"
            disabled={showSource || zoom >= 400}
            onClick={() => setZoom(Math.min(400, zoom + 25))}
          >
            <PlusIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label="Reset zoom"
            variant="soft"
            disabled={showSource}
            onClick={() => setZoom(100)}
          >
            <ResetIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            variant="soft"
            onClick={toggleFullscreen}
          >
            {fullscreen ? <ExitFullScreenIcon /> : <EnterFullScreenIcon />}
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label={showSource ? "Show diagram" : "Show source"}
            variant="soft"
            aria-controls={sourceID}
            aria-pressed={showSource}
            onClick={() => setShowSource(!showSource)}
          >
            {showSource ? <EyeOpenIcon /> : <CodeIcon />}
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label="Copy source"
            variant="soft"
            onClick={() => copy(source)}
          >
            <CopyIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label="Copy SVG"
            variant="soft"
            onClick={() => copy(svg)}
          >
            <CopyIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label="Download SVG"
            variant="soft"
            onClick={download}
          >
            <DownloadIcon />
          </ActionButton>
        </fieldset>
      </Tooltip.Provider>
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
