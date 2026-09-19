import { Badge } from "@radix-ui/themes"
import { useEffect, useState } from "react"
import { getShare, type Share, ShareRequestError } from "../api"
import { DocumentPage } from "./DocumentPage"
import { ErrorPage, LoadingPage, type StatusKind } from "./StatusPage"

function statusForError(error: unknown): StatusKind {
  if (!(error instanceof ShareRequestError)) return "generic"
  if (error.code === "not_found") return "not-found"
  if (error.code === "expired" || error.code === "revoked" || error.code === "view_limit_exhausted")
    return error.code
  return "generic"
}

function ShareDocument({ share }: { share: Share }) {
  return (
    <DocumentPage
      content={share.content}
      filename="morsel.md"
      badges={
        <>
          <Badge color="gray">View {share.view_count}</Badge>
          {share.views_remaining != null && (
            <Badge color="orange">{share.views_remaining} remaining</Badge>
          )}
          {share.expires_at && (
            <Badge color="gray">Expires {new Date(share.expires_at).toLocaleString()}</Badge>
          )}
        </>
      }
    />
  )
}

export function SharePage({ token }: { token: string }) {
  const [state, setState] = useState<{ share?: Share; error?: unknown }>({})

  useEffect(() => {
    let active = true
    void getShare(token).then(
      (share) => {
        if (active) setState({ share })
      },
      (error: unknown) => {
        if (active) setState({ error })
      },
    )
    return () => {
      active = false
    }
  }, [token])

  if (state.share) return <ShareDocument share={state.share} />
  if (state.error) return <ErrorPage kind={statusForError(state.error)} />
  return <LoadingPage />
}
