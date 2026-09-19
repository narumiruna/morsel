import { Badge, Select } from "@radix-ui/themes"
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
  const [state, setState] = useState<{ documents?: GistDocument[]; error?: unknown }>({})
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    let active = true
    void getGist(id).then(
      (documents) => {
        if (active) {
          setSelectedIndex(0)
          setState({ documents })
        }
      },
      (error: unknown) => {
        if (active) setState({ error })
      },
    )
    return () => {
      active = false
    }
  }, [id])

  if (state.documents) {
    const document = state.documents[selectedIndex] ?? state.documents[0]
    if (!document) return <ErrorPage kind="gist-not-found" />
    return (
      <DocumentPage
        content={document.content}
        filename={document.filename}
        sourceUrl={`https://gist.github.com/${id}`}
        badges={
          <>
            <Badge color="gray">GitHub Gist</Badge>
            {state.documents.length === 1 ? (
              <Badge color="gray">{document.filename}</Badge>
            ) : (
              <Select.Root
                value={String(selectedIndex)}
                onValueChange={(value) => setSelectedIndex(Number(value))}
              >
                <Select.Trigger aria-label="Markdown file" />
                <Select.Content>
                  {state.documents.map((item, index) => (
                    <Select.Item key={item.filename} value={String(index)}>
                      {item.filename}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            )}
          </>
        }
      />
    )
  }
  if (state.error) return <ErrorPage kind={statusForError(state.error)} />
  return <LoadingPage subject="Gist" />
}
