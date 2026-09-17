import * as Tooltip from "@radix-ui/react-tooltip"
import { type ReactNode, useEffect, useState } from "react"
import { SharePage } from "./pages/SharePage"
import { ErrorPage, HomePage } from "./pages/StatusPage"
import { parseRoute } from "./route"

export function App() {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    hash: window.location.hash,
  }))
  useEffect(() => {
    const update = () =>
      setLocation({ pathname: window.location.pathname, hash: window.location.hash })
    window.addEventListener("hashchange", update)
    window.addEventListener("popstate", update)
    return () => {
      window.removeEventListener("hashchange", update)
      window.removeEventListener("popstate", update)
    }
  }, [])
  const route = parseRoute(location.pathname, location.hash)

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
