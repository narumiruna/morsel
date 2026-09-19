import {
  CheckIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  EyeOpenIcon,
  FileTextIcon,
  Link2Icon,
  OpenInNewWindowIcon,
} from "@radix-ui/react-icons"
import { Flex, Heading, Separator, Text } from "@radix-ui/themes"
import { type ReactNode, useState } from "react"
import { ActionButton } from "../components/ActionButton"
import { MarkdownDocument } from "../markdown/MarkdownDocument"

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

function downloadMarkdown(content: string, filename: string): void {
  const href = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = href
  link.download = filename
  link.click()
  URL.revokeObjectURL(href)
}

export function DocumentPage({
  content,
  filename,
  badges,
  navigation,
  sourceUrl,
}: {
  content: string
  filename: string
  badges?: ReactNode
  navigation?: ReactNode
  sourceUrl?: string
}) {
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
            {badges && (
              <Flex gap="2" mt="2" wrap="wrap">
                {badges}
              </Flex>
            )}
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
              onClick={() => void perform("Markdown copied", () => copyText(content))}
            >
              <ClipboardCopyIcon />
            </ActionButton>
            <ActionButton
              label="Download Markdown"
              variant="soft"
              onClick={() =>
                void perform("Download started", () => downloadMarkdown(content, filename))
              }
            >
              <DownloadIcon />
            </ActionButton>
            <ActionButton
              label="Copy URL"
              variant="soft"
              onClick={() => void perform("URL copied", () => copyText(window.location.href))}
            >
              <Link2Icon />
            </ActionButton>
            {sourceUrl && (
              <ActionButton label="Open on GitHub" variant="soft" asChild>
                <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
                  <OpenInNewWindowIcon />
                  GitHub
                </a>
              </ActionButton>
            )}
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
      {navigation}
      {raw ? (
        <pre className="raw-markdown">
          <code>{content}</code>
        </pre>
      ) : (
        <MarkdownDocument content={content} />
      )}
    </section>
  )
}
