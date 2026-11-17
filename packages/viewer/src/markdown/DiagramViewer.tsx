import { DiagramViewer as Viewer } from "@narumitw/diagram-viewer"
import "@narumitw/diagram-viewer/styles.css"
import type { RefObject } from "react"
import type { Appearance } from "../theme"

interface DiagramViewerProps {
  appearance?: Appearance
  kind: "mermaid" | "vega-lite"
  ready?: boolean
  refreshing?: boolean
  renderError?: string
  retryRender?: () => void
  source: string
  stageRef?: RefObject<HTMLDivElement | null>
  svg?: string
}

export function DiagramViewer({ appearance = "light", kind, ...props }: DiagramViewerProps) {
  const isChart = kind === "vega-lite"
  const graphicClassName = isChart ? "vega-lite-chart" : "mermaid-diagram"
  return (
    <Viewer
      {...props}
      background={appearance === "dark" ? "#111113" : "#ffffff"}
      filename={graphicClassName}
      graphicName={isChart ? "Vega-Lite chart" : "Mermaid diagram"}
      typeLabel={isChart ? "chart" : "diagram"}
      hostManaged={isChart}
      stageClassName={graphicClassName}
      className={isChart ? "vega-lite-card" : undefined}
    />
  )
}
