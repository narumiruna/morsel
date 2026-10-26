import * as Tooltip from "@radix-ui/react-tooltip"
import { type ReactNode, useRef } from "react"
import { AccountSession } from "./account/AccountSession"
import { AppHeader } from "./components/AppHeader"
import { createInvitationIntake } from "./invitationIntake"
import { useAppLocation } from "./navigation"
import { AccountPage } from "./pages/AccountPage"
import { AuthPage } from "./pages/AuthPage"
import { ExamplePage } from "./pages/ExamplePage"
import { GistPage } from "./pages/GistPage"
import { SharePage } from "./pages/SharePage"
import { ErrorPage, HomePage } from "./pages/StatusPage"
import { parseRoute } from "./route"

export function App() {
  const invitation = useRef<ReturnType<typeof createInvitationIntake> | null>(null)
  if (!invitation.current) invitation.current = createInvitationIntake()
  const location = useAppLocation(invitation.current.capture, invitation.current.clear)
  const route = parseRoute(location.pathname, location.hash)

  let page: ReactNode
  switch (route.kind) {
    case "home":
      page = <HomePage />
      break
    case "authentication":
      page = (
        <AuthPage
          key={`${route.mode}:${location.search}:${location.invitationRevision}`}
          invitation={route.mode === "invite" ? invitation.current : undefined}
          mode={route.mode}
          search={location.search}
        />
      )
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
      {route.kind === "account" ||
      route.kind === "management" ||
      route.kind === "authentication" ? (
        <AccountSession
          pathname={location.pathname}
          search={location.search}
          onAccountChange={invitation.current.clear}
        >
          {page}
        </AccountSession>
      ) : (
        <>
          <AppHeader />
          <main className="app-shell">{page}</main>
        </>
      )}
    </Tooltip.Provider>
  )
}
