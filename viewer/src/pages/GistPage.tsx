import { Badge } from "@radix-ui/themes"
import { useEffect, useState } from "react"
import { type GistDocument, GistRequestError, getGist } from "../api"
import { DocumentPage } from "./DocumentPage"
import { ErrorPage, LoadingPage, type StatusKind } from "./StatusPage"

function statusForError(error: unknown): StatusKind {
  if (!(error instanceof GistRequestError)) return "gist-unavailable"
  if (error.code === "not_found") return "gist-not-found"
  if (error.code === "content_too_large") return "gist-too-large"
  return "gist-unavailable"
}

export function GistPage({ id }: { id: string }) {
  const [state, setState] = useState<{ gist?: GistDocument; error?: unknown }>({})

  useEffect(() => {
    let active = true
    void getGist(id).then(
      (gist) => {
        if (active) setState({ gist })
      },
      (error: unknown) => {
        if (active) setState({ error })
      },
    )
    return () => {
      active = false
    }
  }, [id])

  if (state.gist) {
    return (
      <DocumentPage
        content={state.gist.content}
        filename={state.gist.filename}
        sourceUrl={`https://gist.github.com/${id}`}
        badges={
          <>
            <Badge color="gray">GitHub Gist</Badge>
            <Badge color="gray">{state.gist.filename}</Badge>
          </>
        }
      />
    )
  }
  if (state.error) return <ErrorPage kind={statusForError(state.error)} />
  return <LoadingPage subject="Gist" />
}
