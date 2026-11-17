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
import "@narumitw/diagram-viewer/styles.css"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import embed, { type Result } from "vega-embed"
import { classSource, classSvg, sequenceSource, sequenceSvg } from "./fixtures"

const params = new URLSearchParams(location.search)
const dark = params.get("theme") === "dark"
const initialClass = params.get("kind") === "class"

// Only the public package stylesheet is loaded. Hosts can supply CSS variables
// without a theme provider or app stylesheet.
const theme = {
  "--ndv-background": dark ? "#17212f" : "#ffffff",
  "--ndv-foreground": dark ? "#edf2f7" : "#202124",
  "--ndv-border": dark ? "#71839a" : "#b9c4d3",
  "--ndv-control": dark ? "#33465d" : "#eef0f3",
  "--ndv-focus": dark ? "#9dc5ff" : "#1463d6",
} as CSSProperties

function AppZoomButton() {
  const binding = useDiagramAction("zoomIn")
  return (
    <button {...binding} className="ndv-control app-zoom">
      <span aria-hidden="true">⊕ </span>Zoom in
    </button>
  )
}

function LiveChart() {
  const stage = useRef<HTMLDivElement>(null)
  const chart = useRef<Result | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState("")

  useEffect(() => {
    let disposed = false
    if (!stage.current) return
    void embed(
      stage.current,
      {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        description: "Local amount chart with a minimum amount filter",
        width: 420,
        height: 160,
        background: dark ? "#17212f" : "#ffffff",
        data: {
          values: [
            { category: "A", amount: 2 },
            { category: "B", amount: 5 },
          ],
        },
        params: [
          {
            name: "minimum",
            value: 0,
            bind: { input: "range", min: 0, max: 5, step: 1, name: "Minimum amount " },
          },
        ],
        transform: [{ filter: "datum.amount >= minimum" }],
        mark: "bar",
        encoding: {
          x: { field: "category", type: "nominal" },
          y: { field: "amount", type: "quantitative" },
          color: { value: dark ? "#9dc5ff" : "#285faa" },
        },
        config: {
          axis: {
            labelColor: dark ? "#edf2f7" : "#202124",
            titleColor: dark ? "#edf2f7" : "#202124",
          },
        },
      },
      { actions: false, renderer: "svg", defaultStyle: false },
    ).then(
      (result) => {
        if (disposed) return result.finalize()
        chart.current = result
        // Vega's visible binding text does not create a native label. This is
        // host accessibility work, not part of the diagram package.
        stage.current?.querySelector("input")?.setAttribute("aria-label", "Minimum amount")
        setReady(true)
      },
      (failure: unknown) => setError(String(failure)),
    )
    return () => {
      disposed = true
      chart.current?.finalize()
      chart.current = undefined
    }
  }, [])

  async function updateChart() {
    if (!chart.current) return
    await chart.current.view
      .data("source_0", [
        { category: "C", amount: 4 },
        { category: "D", amount: 3 },
      ])
      .runAsync()
    setVersion((previous) => previous + 1)
  }

  return (
    <section aria-labelledby="live-title">
      <h2 id="live-title">Host-managed live chart</h2>
      <button type="button" onClick={() => void updateChart()} disabled={!ready}>
        Update chart data
      </button>
      <DiagramViewer
        source={'{"mark":"bar","params":[{"name":"minimum","bind":{"input":"range"}}]}'}
        hostManaged
        stageRef={stage}
        ready={ready}
        renderError={error}
        contentVersion={version}
        style={theme}
        className="live-viewer"
        graphicName="amount chart"
        typeLabel="chart"
      />
    </section>
  )
}

function App() {
  const [showClass, setShowClass] = useState(initialClass)
  const [mounted, setMounted] = useState(true)
  const [pinned, setPinned] = useState(false)
  const source = showClass ? classSource : sequenceSource
  const svg = showClass ? classSvg(dark) : sequenceSvg(dark)
  return (
    <main>
      <h1>Standalone diagram viewer</h1>
      <button type="button" onClick={() => setShowClass((previous) => !previous)}>
        Replace SVG
      </button>{" "}
      <button type="button" onClick={() => setMounted((previous) => !previous)}>
        {mounted ? "Unmount viewers" : "Mount viewers"}
      </button>
      {mounted && (
        <>
          <section aria-labelledby="default-title">
            <h2 id="default-title">Default {showClass ? "class" : "sequence"} diagram</h2>
            <DiagramViewer
              source={source}
              svg={svg}
              style={theme}
              className="default-viewer"
              graphicName="document diagram"
              filename="standalone-document"
            />
          </section>
          <section aria-labelledby="custom-title">
            <h2 id="custom-title">Customized controls</h2>
            <DiagramRoot
              source={source}
              svg={svg}
              style={
                {
                  ...theme,
                  "--ndv-radius": "14px",
                  "--ndv-control": dark ? "#235847" : "#d8f4e7",
                } as CSSProperties
              }
              className="custom-viewer"
              graphicName="custom document diagram"
            >
              <DiagramToolbar aria-label="Custom diagram controls">
                <DiagramActionButton action="source" />
                <button
                  type="button"
                  className="ndv-control"
                  aria-pressed={pinned}
                  onClick={() => setPinned((previous) => !previous)}
                >
                  Pin diagram
                </button>
                <AppZoomButton />
                <DiagramZoom />
                <DiagramActionButton action="fit" className="app-fit">
                  <span aria-hidden="true">⤢</span>
                </DiagramActionButton>
                <DiagramActionButton action="fullscreen" />
              </DiagramToolbar>
              <DiagramViewport />
              <DiagramSource />
              <DiagramStatus />
            </DiagramRoot>
          </section>
          <LiveChart />
        </>
      )}
      <p>Local fixtures; no Morsel or Radix theme provider.</p>
    </main>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")
createRoot(root).render(<App />)
