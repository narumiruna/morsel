import {
  DiagramActionButton,
  DiagramRoot,
  DiagramSource,
  DiagramStatus,
  DiagramToolbar,
  DiagramViewer,
  DiagramViewport,
  DiagramZoom,
  useDiagramAction,
} from "@narumitw/diagram-viewer"
import { createDiagramView } from "@narumitw/diagram-viewer/core"
import "@narumitw/diagram-viewer/styles.css"
import { useEffect, useRef, useState } from "react"

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="5" y="20">Trusted SVG</text></svg>'

export function DefaultExample() {
  return <DiagramViewer source="graph TD; A-->B" svg={svg} graphicName="Example diagram" />
}

export function AppZoomButton() {
  const binding = useDiagramAction("zoomIn")
  return (
    <button {...binding} className="app-zoom">
      <span aria-hidden="true">+</span>
    </button>
  )
}

export function ComposedExample() {
  return (
    <DiagramRoot source="graph TD; A-->B" svg={svg}>
      <DiagramToolbar>
        <DiagramActionButton action="source">Source</DiagramActionButton>
        <AppZoomButton />
        <DiagramZoom />
        <button type="button" onClick={() => window.dispatchEvent(new Event("app-action"))}>
          App action
        </button>
      </DiagramToolbar>
      <DiagramViewport />
      <DiagramSource />
      <DiagramStatus />
    </DiagramRoot>
  )
}

/** The host supplies node semantics/actions and inline/expanded touch-action CSS. */
export function SelectableNodeCameraExample(
  viewport: HTMLElement,
  stage: HTMLElement,
  node: SVGElement,
  isExpanded: () => boolean,
) {
  node.setAttribute("data-diagram-node", "")
  return createDiagramView(viewport, stage, { isExpanded })
}

/** The host renderer owns and finalizes children; ready signals completion. */
export function HostMountExample() {
  const stage = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const mount = stage.current
    if (!mount) return
    // Substitute a local renderer call here. Do not pass unsanitized author HTML.
    const child = document.createElement("div")
    child.innerHTML = svg
    mount.append(child)
    setReady(true)
    return () => child.remove() // Finalize the renderer here too.
  }, [])
  return <DiagramViewer source="host source" hostManaged stageRef={stage} ready={ready} />
}
