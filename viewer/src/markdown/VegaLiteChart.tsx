import { ExclamationTriangleIcon, ReloadIcon } from "@radix-ui/react-icons"
import { Button, Callout } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { useAppearance } from "../theme"
import { maxVegaLiteBytes, renderVegaLite } from "./vegaLiteRenderer"

export const maxVegaLiteCharts = 20
export { maxVegaLiteBytes }

const preloadMargin = "800px 0px"

function ChartError({
  message,
  onRetry,
  source,
}: {
  message: string
  onRetry?: () => void
  source: string
}) {
  return (
    <Callout.Root color="red" role="alert" className="vega-lite-error">
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <div>
        <p>{message}</p>
        {onRetry && (
          <Button type="button" variant="soft" onClick={onRetry}>
            <ReloadIcon /> Retry chart
          </Button>
        )}
        <details>
          <summary>Show chart source</summary>
          <pre>
            <code>{source}</code>
          </pre>
        </details>
      </div>
    </Callout.Root>
  )
}

export function VegaLiteChart({ source, index }: { source: string; index: number }) {
  const appearance = useAppearance()
  const container = useRef<HTMLElement>(null)
  const chart = useRef<HTMLDivElement>(null)
  const [eligible, setEligible] = useState(() => typeof IntersectionObserver !== "function")
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const byteLength = new TextEncoder().encode(source).byteLength
  const withinLimits = index < maxVegaLiteCharts && byteLength <= maxVegaLiteBytes

  useEffect(() => {
    if (!withinLimits || eligible || typeof IntersectionObserver !== "function") return
    const target = container.current
    if (!target) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setEligible(true)
        observer.disconnect()
      },
      { rootMargin: preloadMargin },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [eligible, withinLimits])

  // `retry` deliberately restarts a failed render even when all render inputs are unchanged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry is an explicit render generation.
  useEffect(() => {
    if (!withinLimits || !eligible) return
    const target = chart.current
    if (!target) return
    let active = true
    let finalize: (() => void) | undefined
    setReady(false)
    setError("")
    target.replaceChildren()
    void renderVegaLite(target, source, appearance).then(
      (result) => {
        if (!active) {
          result.finalize()
          return
        }
        finalize = result.finalize
        setReady(true)
      },
      () => {
        if (!active) return
        setError("This Vega-Lite chart could not be rendered.")
      },
    )
    return () => {
      active = false
      finalize?.()
      target.replaceChildren()
    }
  }, [appearance, eligible, retry, source, withinLimits])

  if (index >= maxVegaLiteCharts) {
    return (
      <ChartError
        message={`Only the first ${maxVegaLiteCharts} Vega-Lite charts are rendered.`}
        source={source}
      />
    )
  }
  if (byteLength > maxVegaLiteBytes) {
    return <ChartError message="This chart exceeds the 50 KiB source limit." source={source} />
  }
  if (error) {
    return (
      <ChartError
        message={error}
        source={source}
        onRetry={() => {
          setError("")
          setRetry((value) => value + 1)
        }}
      />
    )
  }

  return (
    <section ref={container} className="vega-lite-card" aria-busy={!ready}>
      <div ref={chart} className="vega-lite-chart" role="img" aria-label="Vega-Lite chart" />
      {!ready && (
        <div
          className="vega-lite-loading"
          role="status"
          aria-label={eligible ? "Rendering Vega-Lite chart" : "Waiting to render Vega-Lite chart"}
        />
      )}
    </section>
  )
}
