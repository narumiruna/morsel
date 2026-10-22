import * as Tooltip from "@radix-ui/react-tooltip"
import type { ReactNode } from "react"
import { AppHeader } from "./components/AppHeader"
import { useAppLocation } from "./navigation"
import { AccountPage } from "./pages/AccountPage"
import { ExamplePage } from "./pages/ExamplePage"
import { GistPage } from "./pages/GistPage"
import { SharePage } from "./pages/SharePage"
import { ErrorPage, HomePage } from "./pages/StatusPage"
import { parseRoute } from "./route"

export function App() {
  const location = useAppLocation()
  const route = parseRoute(location.pathname, location.hash)

  let page: ReactNode
  switch (route.kind) {
    case "home":
      page = <HomePage />
      break
    case "account":
    case "management":
      page = <AccountPage section={route.kind === "account" ? "security" : route.section} />
      break
    case "example":
      page = <ExamplePage />
      break
    case "share":
      page = <SharePage key={route.token} token={route.token} />
      break
    case "gist":
      page = <GistPage key={route.id} id={route.id} />
      break
    case "invalid-share":
      page = <ErrorPage kind="invalid-share" />
      break
    case "invalid-gist":
      page = <ErrorPage kind="invalid-gist" />
      break
    default:
      page = <ErrorPage kind="not-found" />
  }

  return (
    <Tooltip.Provider delayDuration={350}>
      {route.kind === "account" || route.kind === "management" ? (
        page
      ) : (
        <>
          <AppHeader />
          <main className="app-shell">{page}</main>
        </>
      )}
    </Tooltip.Provider>
  )
}
