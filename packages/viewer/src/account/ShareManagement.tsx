import { DotsHorizontalIcon } from "@radix-ui/react-icons"
import {
  Button,
  Card,
  Dialog,
  DropdownMenu,
  Flex,
  Heading,
  IconButton,
  Text,
} from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { formatDate } from "../formatDate"
import { MarkdownDocument } from "../markdown/MarkdownDocument"
import { AccountError, accountErrorMessage, accountRequest } from "./accountApi"
import "./shareManagement.css"
import { useAccountSession } from "./AccountSession"
import { useShareLinks } from "./useShareLinks"

export type ShareStatus = "active" | "revoked" | "expired" | "view_limit_exhausted"
export type ShareMetadata = {
  id: string
  label: string
  created_at: string
  expires_at: string | null
  max_views: number | null
  view_count: number
  revoked_at: string | null
  status: ShareStatus
  link_available: boolean
}
export type ShareDetail = ShareMetadata & { content: string }
type SharePage = { items: ShareMetadata[]; next_cursor?: string; matching_count: number }
export type AccountMutation = (
  action: (signal: AbortSignal, csrf: string) => Promise<void>,
) => Promise<boolean>

type ShareFilter = "all" | ShareStatus
type ShareOrder = "newest" | "oldest" | "most_views" | "least_views"
export type ShareListState = {
  search: string
  query: string
  filter: ShareFilter
  order: ShareOrder
}
export const initialShareListState: ShareListState = {
  search: "",
  query: "",
  filter: "all",
  order: "newest",
}
const statuses: Record<ShareStatus, string> = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  view_limit_exhausted: "View limit exhausted",
}

export function ShareManagement({
  busy,
  canVerify,
  mutate,
  onSessionExpired,
  controls,
  onControlsChange,
}: {
  busy: boolean
  canVerify: boolean
  mutate: AccountMutation
  onSessionExpired: () => void
  controls: ShareListState
  onControlsChange: (next: ShareListState) => void
}) {
  const { expectedAccount } = useAccountSession()
  const { search, query, filter, order } = controls
  const [cursors, setCursors] = useState<string[]>([])
  const cursor = cursors.at(-1)
  const [page, setPage] = useState<SharePage | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState("")
  const [invalidCursor, setInvalidCursor] = useState(false)
  const [updated, setUpdated] = useState<string | null>(null)
  const [feedback, setFeedback] = useState("")
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<ShareMetadata | null>(null)
  const selectedID = selected?.id
  const [detail, setDetail] = useState<ShareDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState("")
  const [detailRevision, setDetailRevision] = useState(0)
  const [copyFeedback, setCopyFeedback] = useState("")
  const [confirmation, setConfirmation] = useState<ShareMetadata | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [notice, setNotice] = useState("")
  const mutationLock = useRef(false)
  const listRequest = useRef<AbortController | null>(null)
  const detailRequest = useRef<AbortController | null>(null)
  const lifetime = useRef<AbortController | null>(null)
  const sharesHeading = useRef<HTMLHeadingElement>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const previewDialog = useRef<HTMLDivElement>(null)
  const confirmationHeading = useRef<HTMLHeadingElement>(null)
  const previewTrigger = useRef<HTMLAnchorElement | null>(null)
  const confirmationTrigger = useRef<HTMLElement | null>(null)
  const menuAction = useRef<(() => void) | null>(null)
  const copyGeneration = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => {
      controller.abort()
      copyGeneration.current += 1
    }
  }, [])

  useEffect(() => {
    if (confirmation) confirmationHeading.current?.focus()
  }, [confirmation])

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads the current page.
  useEffect(() => {
    const controller = new AbortController()
    listRequest.current = controller
    const { signal } = controller
    setListLoading(true)
    setListError("")
    setInvalidCursor(false)
    setFeedback("")
    setPage(null)
    const params = new URLSearchParams({ status: filter, limit: "25", sort: order })
    if (query) params.set("q", query)
    if (cursor) params.set("cursor", cursor)
    void accountRequest<SharePage>(`account/shares?${params}`, { signal, expectedAccount })
      .then((result) => {
        if (signal.aborted) return
        setPage(result)
        setUpdated(new Date().toISOString())
        setFeedback(
          `Shares refreshed. ${result.matching_count} matching shares. Page ${cursors.length + 1}.`,
        )
      })
      .catch((failure: unknown) => {
        if (signal.aborted) return
        if (failure instanceof AccountError && failure.status === 401) onSessionExpired()
        else if (failure instanceof AccountError && failure.status === 400 && cursor) {
          setInvalidCursor(true)
          setListError("This share page is no longer valid. Return to the first page.")
        } else setListError(accountErrorMessage(failure))
      })
      .finally(() => {
        if (!signal.aborted) setListLoading(false)
      })
    return () => controller.abort()
  }, [filter, order, query, cursor, cursors.length, revision, onSessionExpired, expectedAccount])

  // biome-ignore lint/correctness/useExhaustiveDependencies: detailRevision explicitly reloads the selected share.
  useEffect(() => {
    if (!selectedID) return
    const controller = new AbortController()
    detailRequest.current = controller
    const { signal } = controller
    setDetail(null)
    setDetailLoading(true)
    setDetailError("")
    setCopyFeedback("")
    copyGeneration.current += 1
    void accountRequest<ShareDetail>(`account/shares/${encodeURIComponent(selectedID)}`, {
      signal,
      expectedAccount,
    })
      .then((result) => {
        if (!signal.aborted) setDetail(result)
      })
      .catch((failure: unknown) => {
        if (signal.aborted) return
        if (failure instanceof AccountError && failure.status === 401) onSessionExpired()
        else setDetailError(accountErrorMessage(failure))
      })
      .finally(() => {
        if (!signal.aborted) setDetailLoading(false)
      })
    return () => controller.abort()
  }, [selectedID, detailRevision, onSessionExpired, expectedAccount])

  const resetPages = () => {
    listRequest.current?.abort()
    setPage(null)
    setListError("")
    setInvalidCursor(false)
    setListLoading(true)
    setCursors([])
    setRevision((value) => value + 1)
  }

  const changeOrder = (value: ShareOrder) => {
    onControlsChange({ ...controls, order: value })
    setConfirmation(null)
    resetPages()
  }

  const refresh = () => {
    listRequest.current?.abort()
    detailRequest.current?.abort()
    copyGeneration.current += 1
    setCopyFeedback("")
    setPage(null)
    setDetail(null)
    setRevision((value) => value + 1)
    setDetailRevision((value) => value + 1)
  }

  const restoreFocus = (trigger: HTMLElement | null) => {
    if (
      trigger?.isConnected &&
      !trigger.matches(":disabled") &&
      trigger.getAttribute("aria-disabled") !== "true"
    )
      trigger.focus()
    else sharesHeading.current?.focus()
  }

  const links = useShareLinks({ expectedAccount, onSessionExpired, restoreFocus })

  const closePreview = () => {
    detailRequest.current?.abort()
    copyGeneration.current += 1
    setSelected(null)
    setDetail(null)
    setDetailError("")
    setCopyFeedback("")
  }

  const copyID = async () => {
    if (!detail) return
    const generation = ++copyGeneration.current
    setCopyFeedback("")
    try {
      await navigator.clipboard.writeText(detail.id)
      if (generation === copyGeneration.current) setCopyFeedback("Share ID copied.")
    } catch {
      if (generation === copyGeneration.current)
        setCopyFeedback("Could not copy share ID. Select and copy the ID below.")
    }
  }

  const revoke = async () => {
    const signal = lifetime.current?.signal
    if (!confirmation || mutationLock.current || busy || !signal || signal.aborted) return
    mutationLock.current = true
    setRevoking(true)
    setNotice("")
    try {
      await mutate(async (parentSignal, csrf) => {
        await accountRequest(`account/shares/${encodeURIComponent(confirmation.id)}`, {
          method: "DELETE",
          csrf,
          signal: parentSignal,
          expectedAccount,
        })
        if (parentSignal.aborted || signal.aborted) return
        setConfirmation(null)
        setNotice("Share revoked. Copies already retrieved are not removed.")
        sharesHeading.current?.focus()
        setCursors([])
        // Refresh even if a later account-list refresh fails.
        refresh()
      })
    } finally {
      mutationLock.current = false
      if (!signal.aborted) setRevoking(false)
    }
  }

  return (
    <Card asChild>
      <section aria-labelledby="shares-heading" className="account-shares">
        <Flex align="center" justify="between" gap="3" wrap="wrap" className="share-toolbar">
          <Heading
            as="h2"
            size="5"
            id="shares-heading"
            className="share-section-heading"
            tabIndex={-1}
            ref={sharesHeading}
          >
            Shares
          </Heading>
          <Button
            variant="ghost"
            color="gray"
            size="2"
            disabled={busy || revoking || listLoading}
            onClick={refresh}
          >
            Refresh shares
          </Button>
        </Flex>
        <details className="share-help">
          <summary>About share management</summary>
          <p>Preview does not use a view.</p>
          <p>Find all shares, including shares created before account setup or with any API key.</p>
          <p>
            Status and view counts are snapshots. Public reads and expiry can change availability.
            Refresh to check again.
          </p>
          <p>
            Copy link copies the saved public URL. Show link displays it below the row actions.
            Older shares may show Link unavailable because their original URLs were not saved.
            Existing public URLs are unchanged. A share ID is not a public link.
          </p>
        </details>
        <form
          className="share-controls"
          onSubmit={(event) => {
            event.preventDefault()
            const normalized = Array.from(search.trim()).slice(0, 100).join("")
            onControlsChange({ ...controls, search: normalized, query: normalized })
            setConfirmation(null)
            resetPages()
          }}
        >
          <div className="share-search">
            <label htmlFor="share-search">Search shares</label>
            <div>
              <input
                id="share-search"
                type="search"
                value={search}
                disabled={busy || revoking}
                onChange={(event) => onControlsChange({ ...controls, search: event.target.value })}
              />
              <Button type="submit" disabled={busy || revoking}>
                Search shares
              </Button>
            </div>
          </div>
          <div className="share-select">
            <label htmlFor="share-order">Share order</label>
            <select
              id="share-order"
              value={order}
              disabled={busy || revoking}
              onChange={(event) => changeOrder(event.target.value as ShareOrder)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="most_views">Most views first</option>
              <option value="least_views">Fewest views first</option>
            </select>
          </div>
          <div className="share-select">
            <label htmlFor="share-status">Share status</label>
            <select
              id="share-status"
              value={filter}
              disabled={busy || revoking}
              onChange={(event) => {
                onControlsChange({ ...controls, filter: event.target.value as ShareFilter })
                setConfirmation(null)
                resetPages()
              }}
            >
              <option value="all">All shares</option>
              {Object.entries(statuses).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </form>
        <div className="share-page-summary">
          {page && (
            <span>
              {page.matching_count} matching shares · Page {cursors.length + 1}
            </span>
          )}
          {updated && (
            <span>
              Last refreshed: <time dateTime={updated}>{formatDate(updated)}</time>
            </span>
          )}
        </div>
        <div role="status" className="share-feedback">
          {feedback}
        </div>
        {listLoading && <Text as="p">Loading shares…</Text>}
        {listError && (
          <div role="alert" className="account-error">
            <Text as="p">{listError}</Text>
            <Button
              variant="soft"
              onClick={invalidCursor ? resetPages : refresh}
              disabled={busy || revoking}
            >
              {invalidCursor ? "Reset share pages" : "Retry shares"}
            </Button>
          </div>
        )}
        {page && page.items.length === 0 && (
          <Text as="p">
            {query || filter !== "all"
              ? "No shares match this search or status."
              : "No shares yet."}
          </Text>
        )}
        {(listLoading || (page && page.items.length > 0)) && (
          <table className="share-table" aria-label="Share history" aria-busy={listLoading}>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th
                  scope="col"
                  aria-sort={
                    order === "most_views"
                      ? "descending"
                      : order === "least_views"
                        ? "ascending"
                        : "none"
                  }
                >
                  <button
                    type="button"
                    className="share-sort-button"
                    disabled={busy || revoking}
                    onClick={() =>
                      changeOrder(order === "most_views" ? "least_views" : "most_views")
                    }
                  >
                    Views
                    <span aria-hidden="true">
                      {order === "most_views" ? " ↓" : order === "least_views" ? " ↑" : " ↕"}
                    </span>
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={
                    order === "newest" ? "descending" : order === "oldest" ? "ascending" : "none"
                  }
                >
                  <button
                    type="button"
                    className="share-sort-button"
                    disabled={busy || revoking}
                    onClick={() => changeOrder(order === "newest" ? "oldest" : "newest")}
                  >
                    Created
                    <span aria-hidden="true">
                      {order === "newest" ? " ↓" : order === "oldest" ? " ↑" : " ↕"}
                    </span>
                  </button>
                </th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {page?.items.map((share) => (
                <tr key={share.id}>
                  <th scope="row" className="share-title">
                    <a
                      href={`#share-preview-${share.id}`}
                      aria-label={`Preview share ${share.label}`}
                      aria-haspopup="dialog"
                      aria-controls={`share-preview-${share.id}`}
                      aria-disabled={busy || revoking}
                      tabIndex={busy || revoking ? -1 : 0}
                      title={share.label}
                      className="share-preview-link"
                      onClick={(event) => {
                        event.preventDefault()
                        if (busy || revoking) return
                        previewTrigger.current = event.currentTarget
                        detailRequest.current?.abort()
                        copyGeneration.current += 1
                        setCopyFeedback("")
                        setDetail(null)
                        setDetailError("")
                        setDetailLoading(true)
                        setSelected(share)
                        setDetailRevision((value) => value + 1)
                      }}
                    >
                      <span>{share.label}</span>
                    </a>
                    {share.expires_at && <small>Expires {compactDate(share.expires_at)}</small>}
                  </th>
                  <td data-label="Status">{statuses[share.status]}</td>
                  <td data-label="Views">
                    {share.view_count}
                    {share.max_views !== null && ` / ${share.max_views}`}
                  </td>
                  <td data-label="Created" className="share-created">
                    <time dateTime={share.created_at}>{compactDate(share.created_at)}</time>
                  </td>
                  <td className="share-actions">
                    <Flex gap="2" align="center">
                      {links.available(share) ? (
                        <Button
                          highContrast
                          aria-label={`Copy link for ${share.label}`}
                          disabled={busy || revoking}
                          aria-disabled={links.loadingID === share.id}
                          aria-busy={links.loadingID === share.id}
                          onClick={(event) => {
                            if (links.loadingID !== share.id)
                              void links.copyLink(share, event.currentTarget)
                          }}
                        >
                          {links.loadingID === share.id ? "Getting link…" : "Copy link"}
                        </Button>
                      ) : (
                        <Text
                          size="1"
                          color="gray"
                          title="The original URL was not saved. Existing public URLs are unchanged."
                        >
                          Link unavailable
                        </Text>
                      )}
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger>
                          <IconButton
                            id={`share-actions-${share.id}`}
                            variant="ghost"
                            color="gray"
                            aria-label={`More actions for ${share.label}`}
                            disabled={busy || revoking}
                          >
                            <DotsHorizontalIcon width="18" height="18" aria-hidden="true" />
                          </IconButton>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content
                          highContrast
                          onCloseAutoFocus={(event) => {
                            const action = menuAction.current
                            if (action) {
                              event.preventDefault()
                              menuAction.current = null
                              action()
                            }
                          }}
                        >
                          <DropdownMenu.Item
                            disabled={!links.available(share)}
                            onSelect={() => {
                              menuAction.current = () =>
                                void links.showLink(
                                  share,
                                  document.getElementById(`share-actions-${share.id}`),
                                )
                            }}
                          >
                            Show link
                          </DropdownMenu.Item>
                          {share.status !== "revoked" && (
                            <>
                              <DropdownMenu.Separator />
                              <DropdownMenu.Item
                                color="red"
                                aria-label={`Revoke share ${share.label}`}
                                disabled={!canVerify}
                                onSelect={() => {
                                  menuAction.current = () => {
                                    confirmationTrigger.current = document.getElementById(
                                      `share-actions-${share.id}`,
                                    )
                                    setNotice("")
                                    setConfirmation(share)
                                  }
                                }}
                              >
                                Revoke
                              </DropdownMenu.Item>
                            </>
                          )}
                        </DropdownMenu.Content>
                      </DropdownMenu.Root>
                    </Flex>
                    {links.panel(share)}
                    {links.copiedID === share.id && (
                      <span className="share-link-result" aria-hidden="true">
                        Link copied
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div role="status">{links.feedback}</div>
        <Flex gap="3" wrap="wrap" mt="3" aria-label="Share pagination">
          <Button
            variant="soft"
            disabled={busy || revoking || listLoading || !page || cursors.length === 0}
            onClick={() => {
              listRequest.current?.abort()
              setPage(null)
              setCursors((values) => values.slice(0, -1))
            }}
          >
            Previous shares
          </Button>
          <Button
            variant="soft"
            disabled={busy || revoking || listLoading || !page?.next_cursor}
            onClick={() => {
              if (!page?.next_cursor) return
              listRequest.current?.abort()
              setPage(null)
              setCursors((values) => [...values, page.next_cursor as string])
            }}
          >
            Next shares
          </Button>
        </Flex>
        {confirmation && (
          <section className="share-confirmation" aria-labelledby="revoke-share-heading">
            <Heading
              as="h3"
              size="4"
              id="revoke-share-heading"
              tabIndex={-1}
              ref={confirmationHeading}
            >
              Revoke share {confirmation.label}?
            </Heading>
            <Text as="p">
              This cannot be undone. The original link will stop working. Revocation does not delete
              the share or remove copies already retrieved or cached elsewhere.
            </Text>
            <Text as="p" size="2">
              Share ID: {confirmation.id}
            </Text>
            <Text as="p" size="2">
              Revocation requires passkey verification within the last 12 hours. If needed, verify
              your passkey after confirmation to continue this revocation once.
            </Text>
            <Flex gap="3" wrap="wrap">
              <Button
                color="red"
                disabled={busy || revoking || !canVerify}
                onClick={() => void revoke()}
              >
                {revoking ? "Revoking share…" : "Confirm revocation"}
              </Button>
              <Button
                variant="soft"
                disabled={busy || revoking}
                onClick={() => {
                  setConfirmation(null)
                  restoreFocus(confirmationTrigger.current)
                }}
              >
                Cancel revocation
              </Button>
            </Flex>
          </section>
        )}
        <div role="status">{notice}</div>
        <Dialog.Root open={selected !== null} onOpenChange={(open) => !open && closePreview()}>
          <Dialog.Content
            className="share-admin-detail"
            id={`share-preview-${selected?.id}`}
            maxWidth="60rem"
            ref={previewDialog}
            onEscapeKeyDown={(event) => {
              // An expanded chart handles Escape before its parent preview closes.
              const dialog = previewDialog.current
              if (
                dialog?.querySelector(".diagram-expanded") ||
                (document.fullscreenElement && dialog?.contains(document.fullscreenElement))
              )
                event.preventDefault()
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              previewHeading.current?.focus()
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              restoreFocus(previewTrigger.current)
            }}
          >
            <div className="share-preview-header">
              <Dialog.Title size="4" mb="0" tabIndex={-1} ref={previewHeading}>
                Share details: {selected?.label}
              </Dialog.Title>
              <Dialog.Close>
                <Button
                  variant="soft"
                  className="share-preview-close"
                  highContrast
                  aria-label="Close share details"
                >
                  Close
                </Button>
              </Dialog.Close>
            </div>
            <Dialog.Description size="2" mb="0">
              Preview does not use a view.
            </Dialog.Description>
            <section
              className="share-preview-body"
              aria-label="Share preview content"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded preview supports keyboard scrolling.
              tabIndex={0}
            >
              {detailLoading && (
                <Text as="p" role="status">
                  Loading share details…
                </Text>
              )}
              {detailError && (
                <div role="alert" className="account-error">
                  <Text as="p">{detailError}</Text>
                  <Button
                    variant="soft"
                    disabled={busy || revoking}
                    highContrast
                    onClick={() => setDetailRevision((value) => value + 1)}
                  >
                    Retry share details
                  </Button>
                </div>
              )}
              {detail && (
                <>
                  <MarkdownDocument content={detail.content} loadImages={false} />
                  <ShareFacts share={detail} />
                  <Text as="p" size="2">
                    {detail.link_available
                      ? "Use the row actions to copy or show the public URL."
                      : "The original public URL was not saved. Existing public URLs are unchanged."}{" "}
                    The share ID is not a public link. Images are not loaded in previews. Mermaid
                    diagrams are shown as source.
                  </Text>
                  <Button variant="soft" highContrast onClick={() => void copyID()}>
                    Copy share ID
                  </Button>
                  <div role="status">{copyFeedback}</div>
                </>
              )}
            </section>
          </Dialog.Content>
        </Dialog.Root>
      </section>
    </Card>
  )
}

function compactDate(value: string): string {
  return formatDate(value).replace(/, \d{2}:\d{2}:\d{2}/, "")
}

function ShareFacts({ share }: { share: ShareMetadata }) {
  return (
    <dl className="share-facts">
      <div>
        <dt>Share ID</dt>
        <dd>
          <code>{share.id}</code>
        </dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>{statuses[share.status]}</dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd>{formatDate(share.created_at)}</dd>
      </div>
      <div>
        <dt>Expires</dt>
        <dd>{share.expires_at ? formatDate(share.expires_at) : "Never"}</dd>
      </div>
      <div>
        <dt>Views</dt>
        <dd>{share.view_count}</dd>
      </div>
      <div>
        <dt>View limit</dt>
        <dd>{share.max_views ?? "Unlimited"}</dd>
      </div>
      {share.revoked_at && (
        <div>
          <dt>Revoked</dt>
          <dd>{formatDate(share.revoked_at)}</dd>
        </div>
      )}
    </dl>
  )
}
