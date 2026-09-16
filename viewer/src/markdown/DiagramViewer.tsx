import {
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  EnterFullScreenIcon,
  ExitFullScreenIcon,
  EyeOpenIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
  ReloadIcon,
  ResetIcon,
} from "@radix-ui/react-icons"
import * as Tooltip from "@radix-ui/react-tooltip"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ActionButton } from "../components/ActionButton"
import type { Appearance } from "../theme"
import { createPngExport, downloadDiagram } from "./diagramExport"
import {
  createDiagramView,
  type DiagramCameraMode,
  type DiagramViewController,
} from "./diagramView"

interface DiagramViewerProps {
  appearance?: Appearance
  refreshing?: boolean
  renderError?: string
  retryRender?: () => void
  source: string
  svg: string
}

interface IsolationRecord {
  element: HTMLElement
  inert: boolean
}

interface ScrollLockRecord {
  element: HTMLElement
  overflow: string
  overscrollBehavior: string
}

export function DiagramViewer({
  appearance = "light",
  refreshing = false,
  renderError = "",
  retryRender,
  source,
  svg,
}: DiagramViewerProps) {
  const card = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const controller = useRef<DiagramViewController | undefined>(undefined)
  const opener = useRef<HTMLElement | undefined>(undefined)
  const isolation = useRef<IsolationRecord[] | undefined>(undefined)
  const scrollLocks = useRef<ScrollLockRecord[] | undefined>(undefined)
  const fallbackRef = useRef(false)
  const nativeFullscreen = useRef(false)
  const sourceID = useId()
  const [zoom, setZoom] = useState(100)
  const [camera, setCamera] = useState<DiagramCameraMode>("overview")
  const [cropped, setCropped] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [status, setStatus] = useState("")
  const expanded = fullscreen || fallback

  const restoreFocus = useCallback(() => {
    const target = opener.current
    opener.current = undefined
    if (target?.isConnected) requestAnimationFrame(() => target.focus({ preventScroll: true }))
  }, [])

  const restoreFallback = useCallback(() => {
    for (const item of isolation.current ?? []) item.element.inert = item.inert
    isolation.current = undefined
    for (const item of scrollLocks.current ?? []) {
      item.element.style.overflow = item.overflow
      item.element.style.overscrollBehavior = item.overscrollBehavior
    }
    scrollLocks.current = undefined
  }, [])

  const closeFallback = useCallback(() => {
    if (!fallbackRef.current) return false
    fallbackRef.current = false
    setFallback(false)
    restoreFallback()
    requestAnimationFrame(() => controller.current?.refresh())
    restoreFocus()
    return true
  }, [restoreFallback, restoreFocus])

  const openFallback = useCallback(() => {
    const element = card.current
    if (!element || fallbackRef.current) return
    const isolated: IsolationRecord[] = []
    let current: HTMLElement = element
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling === current || !(sibling instanceof HTMLElement)) continue
        isolated.push({ element: sibling, inert: sibling.inert })
        sibling.inert = true
      }
      current = current.parentElement
    }
    isolation.current = isolated

    const containers = new Set<HTMLElement>([document.documentElement, document.body])
    current = element.parentElement ?? element
    while (current) {
      const style = getComputedStyle(current)
      if (/(auto|scroll|overlay)/.test(`${style.overflow} ${style.overflowY}`)) {
        containers.add(current)
      }
      if (!current.parentElement) break
      current = current.parentElement
    }
    scrollLocks.current = [...containers].map((item) => ({
      element: item,
      overflow: item.style.overflow,
      overscrollBehavior: item.style.overscrollBehavior,
    }))
    for (const item of scrollLocks.current) {
      item.element.style.overflow = "hidden"
      item.element.style.overscrollBehavior = "none"
    }

    fallbackRef.current = true
    setFallback(true)
    requestAnimationFrame(() => {
      controller.current?.refresh()
      viewport.current?.focus({ preventScroll: true })
    })
  }, [])

  useEffect(() => {
    const view = viewport.current
    const content = stage.current
    if (!view || !content) return
    const next = createDiagramView(view, content, {
      isExpanded: () => document.fullscreenElement === card.current || fallbackRef.current,
      onCameraModeChange: setCamera,
      onCropChange: setCropped,
      onEscape: closeFallback,
      onScaleChange: setZoom,
    })
    controller.current = next
    return () => {
      next.destroy()
      controller.current = undefined
    }
  }, [closeFallback])

  useEffect(() => {
    if (!svg) return
    const frame = requestAnimationFrame(() => controller.current?.refresh())
    return () => cancelAnimationFrame(frame)
  }, [svg])

  useEffect(() => {
    const update = () => {
      const active = document.fullscreenElement === card.current
      setFullscreen(active)
      if (active) {
        nativeFullscreen.current = true
        requestAnimationFrame(() => {
          controller.current?.refresh()
          viewport.current?.focus({ preventScroll: true })
        })
      } else if (nativeFullscreen.current) {
        nativeFullscreen.current = false
        requestAnimationFrame(() => controller.current?.refresh())
        restoreFocus()
      }
    }
    document.addEventListener("fullscreenchange", update)
    return () => document.removeEventListener("fullscreenchange", update)
  }, [restoreFocus])

  useEffect(() => {
    if (!fallback) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !closeFallback()) return
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener("keydown", closeOnEscape, true)
    return () => document.removeEventListener("keydown", closeOnEscape, true)
  }, [closeFallback, fallback])

  useEffect(
    () => () => {
      restoreFallback()
      fallbackRef.current = false
      if (
        document.fullscreenElement === card.current &&
        typeof document.exitFullscreen === "function"
      ) {
        void document.exitFullscreen().catch(() => {})
      }
    },
    [restoreFallback],
  )

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setStatus("Copied to clipboard.")
    } catch {
      setStatus("Copy failed. Check clipboard permissions.")
    }
  }

  async function toggleFullscreen() {
    const element = card.current
    if (!element) return
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest(".diagram-controls")
    ) {
      opener.current = document.activeElement
    }
    if (document.fullscreenElement === element) {
      try {
        await document.exitFullscreen()
      } catch {
        setStatus("Unable to exit fullscreen.")
      }
      return
    }
    if (closeFallback()) return
    try {
      if (typeof element.requestFullscreen !== "function") throw new Error("unavailable")
      await element.requestFullscreen()
    } catch {
      openFallback()
      setStatus("Using fullscreen fallback.")
    }
  }

  function downloadSVG() {
    downloadDiagram(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), "svg")
    setStatus("SVG download started.")
  }

  async function downloadPNG() {
    const diagram = stage.current?.querySelector(":scope > svg")
    if (!(diagram instanceof SVGSVGElement) || exporting) return
    setExporting(true)
    setStatus("Creating PNG…")
    try {
      const png = await createPngExport(diagram, appearance)
      downloadDiagram(png, "png")
      setStatus("PNG download started.")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "PNG export failed.")
    } finally {
      setExporting(false)
    }
  }

  function toggleSource() {
    setShowSource((visible) => {
      if (visible) requestAnimationFrame(() => controller.current?.refresh())
      return !visible
    })
  }

  const tooltipContainer = expanded ? card.current : undefined
  const liveStatus = refreshing ? "Refreshing diagram theme…" : renderError || status

  return (
    <div className={`diagram-card${fallback ? " diagram-expanded" : ""}`} ref={card}>
      <Tooltip.Provider delayDuration={350}>
        <fieldset className="diagram-controls" aria-label="Diagram controls">
          <ActionButton
            className="diagram-control"
            label="Zoom out"
            tooltipContainer={tooltipContainer}
            variant="soft"
            disabled={showSource || zoom <= 25}
            onClick={() => controller.current?.zoomBy(0.8)}
          >
            <MinusIcon />
          </ActionButton>
          <output aria-label="Current zoom">{zoom}%</output>
          <ActionButton
            className="diagram-control"
            label="Zoom in"
            tooltipContainer={tooltipContainer}
            variant="soft"
            disabled={showSource || zoom >= 400}
            onClick={() => controller.current?.zoomBy(1.25)}
          >
            <PlusIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label={camera === "overview" ? "Use readable view" : "Show overview"}
            tooltipContainer={tooltipContainer}
            variant="soft"
            disabled={showSource}
            onClick={() =>
              controller.current?.setCameraMode(camera === "overview" ? "readable" : "overview")
            }
          >
            <MagnifyingGlassIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label="Reset to readable view"
            tooltipContainer={tooltipContainer}
            variant="soft"
            disabled={showSource}
            onClick={() => controller.current?.reset()}
          >
            <ResetIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label={expanded ? "Exit fullscreen" : "Fullscreen"}
            tooltipContainer={tooltipContainer}
            variant="soft"
            onClick={() => void toggleFullscreen()}
          >
            {expanded ? <ExitFullScreenIcon /> : <EnterFullScreenIcon />}
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label={showSource ? "Show diagram" : "Show source"}
            tooltipContainer={tooltipContainer}
            variant="soft"
            aria-controls={sourceID}
            aria-pressed={showSource}
            onClick={toggleSource}
          >
            {showSource ? <EyeOpenIcon /> : <CodeIcon />}
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label="Copy source"
            tooltipContainer={tooltipContainer}
            variant="soft"
            onClick={() => void copy(source)}
          >
            <CopyIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label="Copy SVG"
            tooltipContainer={tooltipContainer}
            variant="soft"
            onClick={() => void copy(svg)}
          >
            <CopyIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label="Download SVG"
            tooltipContainer={tooltipContainer}
            variant="soft"
            onClick={downloadSVG}
          >
            <DownloadIcon />
          </ActionButton>
          <ActionButton
            className="diagram-control"
            label="Download PNG"
            tooltipContainer={tooltipContainer}
            variant="soft"
            disabled={exporting}
            onClick={() => void downloadPNG()}
          >
            <ImageIcon />
          </ActionButton>
          {renderError && retryRender && (
            <ActionButton
              className="diagram-control"
              label="Retry diagram"
              tooltipContainer={tooltipContainer}
              variant="soft"
              disabled={refreshing}
              onClick={retryRender}
            >
              <ReloadIcon />
            </ActionButton>
          )}
        </fieldset>
      </Tooltip.Provider>
      <section
        ref={viewport}
        className="diagram-viewport"
        hidden={showSource}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The diagram viewport provides documented pan and zoom keyboard controls.
        tabIndex={0}
        aria-label="Interactive Mermaid diagram. Use arrow keys to pan, plus or minus to zoom, and zero to fit."
      >
        <div
          ref={stage}
          className="mermaid-diagram"
          role="img"
          aria-label="Mermaid diagram"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG is sanitized by MermaidDiagram before insertion.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </section>
      {cropped && !showSource && (
        <p className="diagram-pan-hint">
          {expanded
            ? "Drag to pan; use two fingers to pan and zoom."
            : "Diagram cropped for readable labels. Drag or use arrow keys to pan."}
        </p>
      )}
      <pre id={sourceID} hidden={!showSource}>
        <code>{source}</code>
      </pre>
      <div className="diagram-status" role="status" aria-live="polite">
        {liveStatus}
      </div>
    </div>
  )
}
