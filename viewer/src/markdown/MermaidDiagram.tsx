import { ExclamationTriangleIcon, ReloadIcon } from "@radix-ui/react-icons"
import { Button, Callout } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { type Appearance, useAppearance } from "../theme"
import { DiagramViewer } from "./DiagramViewer"
import { maxMermaidBytes, renderMermaid } from "./mermaidRenderer"

export const maxMermaidDiagrams = 20
export { maxMermaidBytes }

const preloadMargin = "800px 0px"

function DiagramError({
  message,
  onRetry,
  source,
}: {
  message: string
  onRetry?: () => void
  source: string
}) {
  return (
    <Callout.Root color="red" role="alert" className="diagram-error">
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <div>
        <p>{message}</p>
        {onRetry && (
          <Button type="button" variant="soft" onClick={onRetry}>
            <ReloadIcon /> Retry diagram
          </Button>
        )}
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
  const appearance = useAppearance()
  const pending = useRef<HTMLDivElement>(null)
  const [eligible, setEligible] = useState(() => typeof IntersectionObserver !== "function")
  const [result, setResult] = useState<{
    appearance: Appearance
    source: string
    svg: string
  }>()
  const [error, setError] = useState("")
  const [rendering, setRendering] = useState(false)
  const [retry, setRetry] = useState(0)
  const byteLength = new TextEncoder().encode(source).byteLength
  const withinLimits = index < maxMermaidDiagrams && byteLength <= maxMermaidBytes
  const visibleResult = result?.source === source ? result : undefined

  useEffect(() => {
    if (!withinLimits || eligible || typeof IntersectionObserver !== "function") return
    const target = pending.current
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
    let active = true
    setRendering(true)
    setError("")
    void renderMermaid(source, appearance).then(
      (svg) => {
        if (!active) return
        setResult({ appearance, source, svg })
        setRendering(false)
      },
      () => {
        if (!active) return
        setError("This Mermaid diagram could not be rendered.")
        setRendering(false)
      },
    )
    return () => {
      active = false
    }
  }, [appearance, eligible, retry, source, withinLimits])

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
  if (error && !visibleResult) {
    return (
      <DiagramError
        message={error}
        source={source}
        onRetry={() => {
          setError("")
          setRetry((value) => value + 1)
        }}
      />
    )
  }
  if (!visibleResult) {
    return (
      <div
        ref={pending}
        className="diagram-loading"
        role="status"
        aria-label={eligible ? "Rendering Mermaid diagram" : "Waiting to render Mermaid diagram"}
      />
    )
  }
  return (
    <DiagramViewer
      appearance={visibleResult.appearance}
      refreshing={rendering}
      renderError={error}
      retryRender={() => {
        setError("")
        setRetry((value) => value + 1)
      }}
      source={source}
      svg={visibleResult.svg}
    />
  )
}
