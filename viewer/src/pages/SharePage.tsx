import {
  CheckIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  EyeOpenIcon,
  FileTextIcon,
  Link2Icon,
} from "@radix-ui/react-icons"
import { Badge, Flex, Heading, Separator, Text } from "@radix-ui/themes"
import { useEffect, useState } from "react"
import { getShare, type Share, ShareRequestError } from "../api"
import { ActionButton } from "../components/ActionButton"
import { MarkdownDocument } from "../markdown/MarkdownDocument"
import { ErrorPage, LoadingPage, type StatusKind } from "./StatusPage"

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    const input = document.createElement("textarea")
    input.value = value
    input.setAttribute("readonly", "")
    input.style.position = "fixed"
    input.style.opacity = "0"
    document.body.append(input)
    input.select()
    const copied = document.execCommand("copy")
    input.remove()
    if (!copied) throw new Error("copy failed")
  }
}

function downloadMarkdown(content: string): void {
  const href = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = href
  link.download = "morsel.md"
  link.click()
  URL.revokeObjectURL(href)
}

function statusForError(error: unknown): StatusKind {
  if (!(error instanceof ShareRequestError)) return "generic"
  if (error.code === "not_found") return "not-found"
  if (error.code === "expired" || error.code === "revoked" || error.code === "view_limit_exhausted")
    return error.code
  return "generic"
}

function DocumentView({ share }: { share: Share }) {
  const [raw, setRaw] = useState(false)
  const [feedback, setFeedback] = useState("")

  const perform = async (message: string, action: () => void | Promise<void>) => {
    try {
      await action()
      setFeedback(message)
    } catch {
      setFeedback("Action failed")
    }
  }

  return (
    <section className="share-view" aria-labelledby="document-title">
      <header className="document-header">
        <Flex justify="between" align="start" gap="4" wrap="wrap">
          <div>
            <Heading id="document-title" size="6">
              Morsel
            </Heading>
            <Flex gap="2" mt="2" wrap="wrap">
              <Badge color="gray">View {share.view_count}</Badge>
              {share.views_remaining != null && (
                <Badge color="orange">{share.views_remaining} remaining</Badge>
              )}
              {share.expires_at && (
                <Badge color="gray">Expires {new Date(share.expires_at).toLocaleString()}</Badge>
              )}
            </Flex>
          </div>
          <Flex gap="2" wrap="wrap" className="document-actions">
            <ActionButton
              label={raw ? "Show rendered document" : "Show raw Markdown"}
              variant="soft"
              onClick={() => setRaw((value) => !value)}
            >
              {raw ? <EyeOpenIcon /> : <FileTextIcon />}
              {raw ? "Rendered" : "Raw"}
            </ActionButton>
            <ActionButton
              label="Copy Markdown"
              variant="soft"
              onClick={() => void perform("Markdown copied", () => copyText(share.content))}
            >
              <ClipboardCopyIcon />
            </ActionButton>
            <ActionButton
              label="Download Markdown"
              variant="soft"
              onClick={() =>
                void perform("Download started", () => downloadMarkdown(share.content))
              }
            >
              <DownloadIcon />
            </ActionButton>
            <ActionButton
              label="Copy share URL"
              variant="soft"
              onClick={() => void perform("Share URL copied", () => copyText(window.location.href))}
            >
              <Link2Icon />
            </ActionButton>
          </Flex>
        </Flex>
        <Text className="action-feedback" role="status" aria-live="polite" size="2" color="green">
          {feedback && (
            <>
              <CheckIcon /> {feedback}
            </>
          )}
        </Text>
      </header>
      <Separator size="4" />
      {raw ? (
        <pre className="raw-markdown">
          <code>{share.content}</code>
        </pre>
      ) : (
        <MarkdownDocument content={share.content} />
      )}
    </section>
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

  if (state.share) return <DocumentView share={state.share} />
  if (state.error) return <ErrorPage kind={statusForError(state.error)} />
  return <LoadingPage />
}
