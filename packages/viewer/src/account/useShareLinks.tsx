import { Button, Flex, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { AccountError, accountErrorMessage, accountRequest } from "./accountApi"
import type { ShareMetadata } from "./ShareManagement"

// Capabilities stay in this mounted section only, never in browser storage or history.
export function useShareLinks({
  onSessionExpired,
  restoreFocus,
}: {
  onSessionExpired: () => void
  restoreFocus: (trigger: HTMLElement | null) => void
}) {
  const links = useRef(new Map<string, string>())
  const [selected, setSelected] = useState<ShareMetadata | null>(null)
  const [url, setURL] = useState("")
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [copiedID, setCopiedID] = useState<string | null>(null)
  const [loadingID, setLoadingID] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(new Set<string>())
  const trigger = useRef<HTMLElement | null>(null)
  const request = useRef<AbortController | null>(null)
  const urlInput = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const cache = links.current
    return () => {
      request.current?.abort()
      cache.clear()
    }
  }, [])

  useEffect(() => {
    if (selected && url) {
      urlInput.current?.focus()
      urlInput.current?.select()
    }
  }, [selected, url])

  const close = () => {
    request.current?.abort()
    setSelected(null)
    setURL("")
    setError("")
    setFeedback("")
    setLoadingID(null)
    restoreFocus(trigger.current)
  }

  const begin = (share: ShareMetadata, element: HTMLElement | null) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    trigger.current = element
    setSelected(null)
    setURL("")
    setError("")
    setFeedback("")
    setCopiedID(null)
    setLoadingID(share.id)
    return controller.signal
  }

  const load = async (share: ShareMetadata, signal: AbortSignal) => {
    const cached = links.current.get(share.id)
    if (cached) return cached
    const result = await accountRequest<{ share_url: string }>(
      `account/shares/${encodeURIComponent(share.id)}/link`,
      { signal },
    )
    signal.throwIfAborted()
    links.current.set(share.id, result.share_url)
    return result.share_url
  }

  const failed = (share: ShareMetadata, failure: unknown) => {
    if (failure instanceof AccountError && failure.status === 401) {
      links.current.clear()
      setSelected(null)
      setURL("")
      onSessionExpired()
      return
    }
    if (failure instanceof AccountError && failure.code === "link_unavailable") {
      setUnavailable((value) => new Set(value).add(share.id))
    }
    setSelected(share)
    setError(accountErrorMessage(failure))
  }

  const showLink = async (share: ShareMetadata, element: HTMLElement | null) => {
    const signal = begin(share, element)
    setSelected(share)
    try {
      const value = await load(share, signal)
      if (!signal.aborted) setURL(value)
    } catch (failure) {
      if (!signal.aborted) failed(share, failure)
    } finally {
      if (!signal.aborted) setLoadingID(null)
    }
  }

  const copyLink = async (share: ShareMetadata, element: HTMLElement | null) => {
    const cached = links.current.get(share.id)
    const signal = begin(share, element)
    const pending = load(share, signal)
    // A clipboard rejection can occur before the network request settles.
    void pending.catch(() => {})
    try {
      if (!cached && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        // Start the write during the click, before fetching, to preserve Safari user activation.
        const text = pending.then((value) => new Blob([value], { type: "text/plain" }))
        void text.catch(() => {})
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })])
      } else {
        const value = cached ?? (await pending)
        signal.throwIfAborted()
        await navigator.clipboard.writeText(value)
      }
      if (!signal.aborted) {
        setFeedback(`Link copied. ${share.label}`)
        setCopiedID(share.id)
      }
    } catch {
      if (signal.aborted) return
      try {
        const value = await pending
        if (signal.aborted) return
        setSelected(share)
        setURL(value)
        setFeedback("Could not copy link. Select and copy the displayed URL.")
      } catch (failure) {
        if (!signal.aborted) failed(share, failure)
      }
    } finally {
      if (!signal.aborted) setLoadingID(null)
    }
  }

  const available = (share: ShareMetadata) => share.link_available && !unavailable.has(share.id)

  return {
    copyLink,
    showLink,
    available,
    copiedID,
    loadingID,
    feedback,
    panel: (share: ShareMetadata) =>
      selected?.id === share.id ? (
        <section className="share-link-panel" aria-label={`Public link: ${share.label}`}>
          {loadingID === share.id && (
            <Text as="p" role="status">
              Loading link…
            </Text>
          )}
          {error && (
            <Text as="p" role="alert">
              {error}
            </Text>
          )}
          {url && (
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
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault()
                    close()
                  }
                }}
              />
              {share.status !== "active" && (
                <Text as="p" size="2">
                  This share is no longer available to readers. Copying does not reactivate it.
                </Text>
              )}
            </>
          )}
          <Flex gap="2" wrap="wrap" mt="2">
            {url && (
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
            )}
            {error && available(share) && (
              <Button
                variant="soft"
                highContrast
                onClick={() => void showLink(share, trigger.current)}
              >
                Retry link
              </Button>
            )}
            <Button variant="soft" highContrast onClick={close}>
              Hide link
            </Button>
          </Flex>
        </section>
      ) : null,
  }
}
