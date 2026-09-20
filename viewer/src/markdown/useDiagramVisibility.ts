import { useEffect, useRef, useState } from "react"

export function useDiagramVisibility(withinLimits: boolean) {
  const pending = useRef<HTMLDivElement>(null)
  const [eligible, setEligible] = useState(() => typeof IntersectionObserver !== "function")

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
      { rootMargin: "800px 0px" },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [eligible, withinLimits])

  return { pending, eligible }
}
