import * as Tooltip from "@radix-ui/react-tooltip"
import { type ReactNode, useEffect, useState } from "react"
import { SharePage } from "./pages/SharePage"
import { ErrorPage, HomePage } from "./pages/StatusPage"
import { parseHash } from "./route"

export function App() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const update = () => setHash(window.location.hash)
    window.addEventListener("hashchange", update)
    return () => window.removeEventListener("hashchange", update)
  }, [])
  const route = parseHash(hash)

  let page: ReactNode
  switch (route.kind) {
    case "home":
      page = <HomePage />
      break
    case "share":
      page = <SharePage key={route.token} token={route.token} />
      break
    case "invalid-share":
      page = <ErrorPage kind="invalid-share" />
      break
    default:
      page = <ErrorPage kind="not-found" />
  }

  return (
    <Tooltip.Provider delayDuration={350}>
      <main className="app-shell">{page}</main>
    </Tooltip.Provider>
  )
}
