import { Button, Card, Flex, Heading, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { MarkdownDocument } from "../markdown/MarkdownDocument"
import { AccountError, accountErrorMessage, accountRequest } from "./accountApi"

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
type SharePage = { items: ShareMetadata[]; next_cursor?: string }
export type AccountMutation = (
  action: (signal: AbortSignal, csrf: string) => Promise<void>,
) => Promise<boolean>

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
  const [filter, setFilter] = useState<"all" | ShareStatus>("all")
  const [cursors, setCursors] = useState<string[]>([])
  const cursor = cursors.at(-1)
  const [page, setPage] = useState<SharePage | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState("")
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<ShareMetadata | null>(null)
  const selectedID = selected?.id
  const [detail, setDetail] = useState<ShareDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState("")
  const [detailRevision, setDetailRevision] = useState(0)
  const [confirmation, setConfirmation] = useState<ShareMetadata | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [notice, setNotice] = useState("")
  const mutationLock = useRef(false)
  const listRequest = useRef<AbortController | null>(null)
  const detailRequest = useRef<AbortController | null>(null)
  const lifetime = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads the current page.
  useEffect(() => {
    const controller = new AbortController()
    listRequest.current = controller
    const { signal } = controller
    setListLoading(true)
    setListError("")
    setPage(null)
    const query = new URLSearchParams({ status: filter, limit: "25" })
    if (cursor) query.set("cursor", cursor)
    void accountRequest<SharePage>(`account/shares?${query}`, { signal })
      .then((result) => {
        if (!signal.aborted) setPage(result)
      })
      .catch((failure: unknown) => {
        if (signal.aborted) return
        if (failure instanceof AccountError && failure.status === 401) onSessionExpired()
        else setListError(accountErrorMessage(failure))
      })
      .finally(() => {
        if (!signal.aborted) setListLoading(false)
      })
    return () => controller.abort()
  }, [filter, cursor, revision, onSessionExpired])

  // biome-ignore lint/correctness/useExhaustiveDependencies: detailRevision explicitly reloads the selected share.
  useEffect(() => {
    if (!selectedID) return
    const controller = new AbortController()
    detailRequest.current = controller
    const { signal } = controller
    setDetail(null)
    setDetailLoading(true)
    setDetailError("")
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

  const refresh = () => {
    listRequest.current?.abort()
    detailRequest.current?.abort()
    setPage(null)
    setDetail(null)
    setRevision((value) => value + 1)
    setDetailRevision((value) => value + 1)
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
          <Heading as="h2" size="5" id="shares-heading">
            Shares
          </Heading>
          <Button variant="soft" disabled={busy || revoking} onClick={refresh}>
            Refresh shares
          </Button>
        </Flex>
        <Text as="p">
          Manage all shares, including shares created before account setup or with any API key.
          Reading here does not use a view.
        </Text>
        <Text as="p" size="2">
          Status and view counts are snapshots. Public reads and expiry can change availability.
          Refresh to check again. Revocation requires passkey verification within the last 12 hours.
        </Text>
        <div className="share-filter">
          <label htmlFor="share-status">Share status</label>
          <select
            id="share-status"
            value={filter}
            disabled={busy || revoking}
            onChange={(event) => {
              listRequest.current?.abort()
              setPage(null)
              setListError("")
              setListLoading(true)
              setFilter(event.target.value as typeof filter)
              setCursors([])
              setConfirmation(null)
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
        {listLoading && <Text as="p">Loading shares…</Text>}
        {listError && (
          <div role="alert" className="account-error">
            <Text as="p">{listError}</Text>
            <Button variant="soft" onClick={refresh} disabled={busy || revoking}>
              Retry shares
            </Button>
          </div>
        )}
        {page && (
          <>
            {page.items.length === 0 ? (
              <Text as="p">
                {filter === "all" ? "No shares yet." : "No shares match this status."}
              </Text>
            ) : (
              <ul className="account-list share-list" aria-label="Share history">
                {page.items.map((share) => (
                  <li key={share.id}>
                    <div className="share-summary">
                      <strong>{share.label}</strong>
                      <ShareFacts share={share} />
                    </div>
                    <Flex gap="2" wrap="wrap">
                      <Button
                        variant="soft"
                        aria-label={`View share ${share.label}`}
                        disabled={busy || revoking}
                        onClick={() => {
                          detailRequest.current?.abort()
                          setDetail(null)
                          setDetailError("")
                          setDetailLoading(true)
                          setSelected(share)
                          setDetailRevision((value) => value + 1)
                        }}
                      >
                        View
                      </Button>
                      {share.status !== "revoked" && (
                        <Button
                          variant="soft"
                          color="red"
                          aria-label={`Revoke share ${share.label}`}
                          disabled={busy || revoking || !canVerify}
                          onClick={() => {
                            setNotice("")
                            setConfirmation(share)
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </Flex>
                  </li>
                ))}
              </ul>
            )}
            <Flex gap="3" wrap="wrap" mt="3" aria-label="Share pagination">
              <Button
                variant="soft"
                disabled={busy || revoking || cursors.length === 0}
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
                disabled={busy || revoking || !page.next_cursor}
                onClick={() => {
                  if (!page.next_cursor) return
                  listRequest.current?.abort()
                  setPage(null)
                  setCursors((values) => [...values, page.next_cursor as string])
                }}
              >
                Next shares
              </Button>
            </Flex>
          </>
        )}
        {confirmation && (
          <section className="share-confirmation" aria-labelledby="revoke-share-heading">
            <Heading as="h3" size="4" id="revoke-share-heading">
              Revoke share {confirmation.label}?
            </Heading>
            <Text as="p">
              This cannot be undone. The original link will stop working. Revocation does not delete
              the share or remove copies already retrieved or cached elsewhere.
            </Text>
            <Text as="p" size="2">
              Share ID: {confirmation.id}
            </Text>
            <Flex gap="3" wrap="wrap">
              <Button
                color="red"
                disabled={busy || revoking || !canVerify}
                onClick={() => void revoke()}
              >
                Confirm revocation
              </Button>
              <Button
                variant="soft"
                disabled={busy || revoking}
                onClick={() => setConfirmation(null)}
              >
                Cancel revocation
              </Button>
            </Flex>
          </section>
        )}
        {notice && (
          <Text as="p" aria-live="polite">
            {notice}
          </Text>
        )}
        {selected && (
          <section className="share-admin-detail" aria-labelledby="share-detail-heading">
            <Flex align="center" justify="between" gap="3" wrap="wrap">
              <Heading as="h3" size="4" id="share-detail-heading">
                Share details: {selected.label}
              </Heading>
              <Button
                variant="soft"
                disabled={busy || revoking}
                onClick={() => {
                  detailRequest.current?.abort()
                  setSelected(null)
                  setDetail(null)
                  setDetailError("")
                }}
              >
                Close share details
              </Button>
            </Flex>
            <Text as="p">
              The original public URL cannot be recovered. The share ID is not a public link. Images
              are not loaded during administrative inspection. Mermaid diagrams are shown as source.
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
                <MarkdownDocument content={detail.content} loadImages={false} />
              </>
            )}
          </section>
        )}
      </section>
    </Card>
  )
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

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
