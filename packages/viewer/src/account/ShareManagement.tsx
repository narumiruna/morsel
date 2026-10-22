import { Button, Card, Flex, Heading, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { formatDate } from "../formatDate"
import { MarkdownDocument } from "../markdown/MarkdownDocument"
import { AccountError, accountErrorMessage, accountRequest } from "./accountApi"
import "./shareManagement.css"

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
}
export type ShareDetail = ShareMetadata & { content: string }
type SharePage = { items: ShareMetadata[]; next_cursor?: string; matching_count: number }
export type AccountMutation = (
  action: (signal: AbortSignal, csrf: string) => Promise<void>,
) => Promise<boolean>

type ShareFilter = "all" | ShareStatus
type ShareOrder = "newest" | "oldest"
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
}: {
  busy: boolean
  canVerify: boolean
  mutate: AccountMutation
  onSessionExpired: () => void
}) {
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<ShareFilter>("all")
  const [order, setOrder] = useState<ShareOrder>("newest")
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
  const confirmationHeading = useRef<HTMLHeadingElement>(null)
  const previewTrigger = useRef<HTMLButtonElement | null>(null)
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null)
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
    if (selectedID) previewHeading.current?.focus()
  }, [selectedID])

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
    void accountRequest<SharePage>(`account/shares?${params}`, { signal })
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
  }, [filter, order, query, cursor, cursors.length, revision, onSessionExpired])

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
  }, [selectedID, detailRevision, onSessionExpired])

  const resetPages = () => {
    listRequest.current?.abort()
    setPage(null)
    setListError("")
    setInvalidCursor(false)
    setListLoading(true)
    setCursors([])
    setRevision((value) => value + 1)
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

  const restoreFocus = (trigger: HTMLButtonElement | null) => {
    if (trigger?.isConnected && !trigger.disabled) trigger.focus()
    else sharesHeading.current?.focus()
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
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          <Heading as="h2" size="5" id="shares-heading" tabIndex={-1} ref={sharesHeading}>
            Shares
          </Heading>
          <Button variant="soft" disabled={busy || revoking || listLoading} onClick={refresh}>
            Refresh shares
          </Button>
        </Flex>
        <Text as="p" size="2">
          Preview does not use a view.
        </Text>
        <details className="share-help">
          <summary>About share management</summary>
          <p>Find all shares, including shares created before account setup or with any API key.</p>
          <p>
            Status and view counts are snapshots. Public reads and expiry can change availability.
            Refresh to check again.
          </p>
          <p>The original public URL cannot be recovered. A share ID is not a public link.</p>
        </details>
        <form
          className="share-controls"
          onSubmit={(event) => {
            event.preventDefault()
            const normalized = Array.from(search.trim()).slice(0, 100).join("")
            setSearch(normalized)
            setQuery(normalized)
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
                onChange={(event) => setSearch(event.target.value)}
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
              onChange={(event) => {
                setOrder(event.target.value as ShareOrder)
                setConfirmation(null)
                resetPages()
              }}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
          <div className="share-select">
            <label htmlFor="share-status">Share status</label>
            <select
              id="share-status"
              value={filter}
              disabled={busy || revoking}
              onChange={(event) => {
                setFilter(event.target.value as ShareFilter)
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
        {page &&
          (page.items.length === 0 ? (
            <Text as="p">
              {query || filter !== "all"
                ? "No shares match this search or status."
                : "No shares yet."}
            </Text>
          ) : (
            <table className="share-table" aria-label="Share history">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Views</th>
                  <th scope="col">Created</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((share) => (
                  <tr key={share.id}>
                    <th scope="row" className="share-title">
                      <span>{share.label}</span>
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
                      <Button
                        variant="soft"
                        aria-label={`Preview share ${share.label}`}
                        disabled={busy || revoking}
                        onClick={(event) => {
                          previewTrigger.current = event.currentTarget
                          detailRequest.current?.abort()
                          copyGeneration.current += 1
                          setCopyFeedback("")
                          setDetail(null)
                          setDetailError("")
                          setDetailLoading(true)
                          setSelected(share)
                          previewHeading.current?.focus()
                          setDetailRevision((value) => value + 1)
                        }}
                      >
                        Preview
                      </Button>
                      {share.status !== "revoked" && (
                        <Button
                          variant="soft"
                          color="red"
                          aria-label={`Revoke share ${share.label}`}
                          disabled={busy || revoking || !canVerify}
                          onClick={(event) => {
                            confirmationTrigger.current = event.currentTarget
                            setNotice("")
                            setConfirmation(share)
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
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
        {selected && (
          <section className="share-admin-detail" aria-labelledby="share-detail-heading">
            <Flex align="center" justify="between" gap="3" wrap="wrap">
              <Heading
                as="h3"
                size="4"
                id="share-detail-heading"
                tabIndex={-1}
                ref={previewHeading}
              >
                Share details: {selected.label}
              </Heading>
              <Button
                variant="soft"
                disabled={busy || revoking}
                onClick={() => {
                  detailRequest.current?.abort()
                  copyGeneration.current += 1
                  setSelected(null)
                  setDetail(null)
                  setDetailError("")
                  setCopyFeedback("")
                  restoreFocus(previewTrigger.current)
                }}
              >
                Close share details
              </Button>
            </Flex>
            <Text as="p" size="2">
              The original public URL cannot be recovered. The share ID is not a public link. Images
              are not loaded in previews. Mermaid diagrams are shown as source.
            </Text>
            {detailLoading && <Text as="p">Loading share details…</Text>}
            {detailError && (
              <div role="alert" className="account-error">
                <Text as="p">{detailError}</Text>
                <Button
                  variant="soft"
                  disabled={busy || revoking}
                  onClick={() => setDetailRevision((value) => value + 1)}
                >
                  Retry share details
                </Button>
              </div>
            )}
            {detail && (
              <>
                <ShareFacts share={detail} />
                <Button variant="soft" onClick={() => void copyID()}>
                  Copy share ID
                </Button>
                <div role="status">{copyFeedback}</div>
                <MarkdownDocument content={detail.content} loadImages={false} />
              </>
            )}
          </section>
        )}
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
