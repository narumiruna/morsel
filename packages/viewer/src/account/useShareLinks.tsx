import { Button, Dialog, Flex, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { parseDocumentUrl } from "../documentUrl"
import { parseRoute } from "../route"
import { AccountError, accountErrorMessage, accountRequest } from "./accountApi"
import type { ShareMetadata } from "./ShareManagement"

// Capabilities stay in this mounted section only, never in browser storage or history.
export function useShareLinks({
  csrf,
  onSessionExpired,
  restoreFocus,
}: {
  csrf?: string
  onSessionExpired: () => void
  restoreFocus: (trigger: HTMLElement | null) => void
}) {
  const [links, setLinks] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<ShareMetadata | null>(null)
  const [original, setOriginal] = useState("")
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [copiedID, setCopiedID] = useState<string | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const urlInput = useRef<HTMLTextAreaElement>(null)
  const url = selected ? links[selected.id] : undefined

  useEffect(
    () => () => {
      request.current?.abort()
      generation.current += 1
    },
    [],
  )

  useEffect(() => {
    if (url) {
      urlInput.current?.focus()
      urlInput.current?.select()
    }
  }, [url])

  const close = () => {
    request.current?.abort()
    generation.current += 1
    setSelected(null)
    setOriginal("")
    setError("")
    setFeedback("")
    setCopiedID(null)
    setVerifying(false)
  }

  const showLink = (share: ShareMetadata, element: HTMLElement | null) => {
    request.current?.abort()
    generation.current += 1
    trigger.current = element
    setOriginal("")
    setError("")
    setFeedback("")
    setCopiedID(null)
    setVerifying(false)
    setSelected(share)
  }

  const copyLink = async (share: ShareMetadata, element: HTMLElement | null) => {
    const link = links[share.id]
    if (!link) {
      showLink(share, element)
      return
    }
    const current = ++generation.current
    setFeedback("")
    setCopiedID(null)
    try {
      await navigator.clipboard.writeText(link)
      if (current === generation.current) {
        setFeedback(`Link copied. ${share.label}`)
        setCopiedID(share.id)
      }
    } catch {
      if (current !== generation.current) return
      if (!selected) showLink(share, element)
      setFeedback("Could not copy link. Select and copy the complete URL below.")
      urlInput.current?.focus()
      urlInput.current?.select()
    }
  }

  const verify = async () => {
    if (!selected || verifying) return
    const path = parseDocumentUrl(original, window.location.origin)
    const parsed = path ? new URL(path, window.location.origin) : null
    const route = parsed ? parseRoute(parsed.pathname, parsed.hash) : null
    setError("")
    if (route?.kind !== "share") {
      setError("Enter an original public share URL from this Morsel site.")
      return
    }
    const controller = new AbortController()
    request.current?.abort()
    request.current = controller
    setVerifying(true)
    try {
      const result = await accountRequest<{ share_url: string }>(
        `account/shares/${encodeURIComponent(selected.id)}/link`,
        { method: "POST", body: { token: route.token }, csrf, signal: controller.signal },
      )
      if (controller.signal.aborted) return
      setLinks((value) => ({ ...value, [selected.id]: result.share_url }))
      setOriginal("")
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof AccountError && failure.status === 401) onSessionExpired()
      else setError(accountErrorMessage(failure))
    } finally {
      if (!controller.signal.aborted) setVerifying(false)
    }
  }

  return {
    copyLink,
    showLink,
    copiedID,
    feedback: selected ? "" : feedback,
    dialog: (
      <Dialog.Root open={selected !== null} onOpenChange={(open) => !open && close()}>
        <Dialog.Content
          className="share-link-dialog"
          maxWidth="36rem"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocus(trigger.current)
          }}
        >
          <Dialog.Title size="4">Public link: {selected?.label}</Dialog.Title>
          <Dialog.Description size="2">
            {url
              ? "Anyone with this URL can read the share while it is available. Copying does not use a view or change availability."
              : "Morsel stores only a token hash, so it cannot recover the original public URL. Supply the original link to enable copying for this visit."}
          </Dialog.Description>
          {selected && selected.status !== "active" && (
            <Text as="p" size="2" weight="medium">
              {selected.status === "revoked"
                ? "Revoked. This link no longer grants public access."
                : selected.status === "expired"
                  ? "Expired. This link no longer grants public access."
                  : "View limit exhausted. This link no longer grants public access."}{" "}
              Copying does not reactivate it.
            </Text>
          )}
          {url ? (
            <>
              <label htmlFor="public-share-url">Public share URL</label>
              <textarea
                id="public-share-url"
                ref={urlInput}
                readOnly
                value={url}
                rows={3}
                spellCheck={false}
                autoComplete="off"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Flex gap="3" wrap="wrap" mt="3">
                <Button
                  highContrast
                  onClick={() => selected && void copyLink(selected, trigger.current)}
                >
                  Copy link
                </Button>
                <Button
                  variant="soft"
                  highContrast
                  onClick={() => {
                    urlInput.current?.focus()
                    urlInput.current?.select()
                  }}
                >
                  Select link
                </Button>
              </Flex>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void verify()
              }}
            >
              <label htmlFor="original-share-url">Original public URL</label>
              <input
                id="original-share-url"
                type="text"
                inputMode="url"
                value={original}
                onChange={(event) => setOriginal(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                aria-describedby="share-link-memory"
              />
              <Text as="p" size="2" id="share-link-memory">
                The link is checked against this share without opening it. It stays only in page
                memory and is cleared when you leave Shares or sign out.
              </Text>
              <Button type="submit" highContrast disabled={verifying}>
                {verifying ? "Checking link…" : "Use original link"}
              </Button>
            </form>
          )}
          <div role="alert">{error}</div>
          <div role="status">{feedback}</div>
          <Flex justify="end" mt="3">
            <Dialog.Close>
              <Button variant="soft" highContrast>
                Close link
              </Button>
            </Dialog.Close>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    ),
  }
}
