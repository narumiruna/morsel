import {
  AlertDialog,
  Badge,
  Button,
  Card,
  Flex,
  Heading,
  Link,
  Text,
  TextField,
} from "@radix-ui/themes"
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import {
  listShares,
  type ManagedShare,
  ManagementError,
  revokeShare,
  type ShareList,
} from "../management"

const statusLabels = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  view_limit_exhausted: "View limit reached",
} as const

function date(value: string): string {
  return new Date(value).toLocaleString()
}

function ManagementSession({
  apiKey,
  disconnect,
}: {
  apiKey: string
  disconnect: (unauthorized?: boolean) => void
}) {
  const [query, setQuery] = useState({ offset: 0 })
  const { offset } = query
  const [page, setPage] = useState<ShareList>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [selected, setSelected] = useState<ManagedShare>()
  const [revoking, setRevoking] = useState(false)
  const mutation = useRef<AbortController | undefined>(undefined)
  const revokeTrigger = useRef<HTMLButtonElement | null>(null)
  const disconnectButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => () => mutation.current?.abort(), [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setPage(undefined)
    setSelected(undefined)
    setError("")
    void listShares(apiKey, query.offset, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        setPage(result)
        setLoading(false)
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return
        if (cause instanceof ManagementError && cause.status === 401) {
          disconnect(true)
          return
        }
        setError("Unable to load morsels. Try refreshing the list.")
        setLoading(false)
      },
    )
    return () => controller.abort()
  }, [apiKey, query, disconnect])

  async function confirmRevocation() {
    if (!selected || revoking) return
    const controller = new AbortController()
    mutation.current = controller
    setRevoking(true)
    setError("")
    setFeedback("")
    try {
      await revokeShare(apiKey, selected.id, controller.signal)
      if (controller.signal.aborted) return
      setSelected(undefined)
      setFeedback("Morsel revoked.")
      setQuery((value) => ({ ...value }))
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ManagementError && cause.status === 401) {
        disconnect(true)
        return
      }
      setError("Unable to revoke this morsel. Try again.")
    } finally {
      if (!controller.signal.aborted) setRevoking(false)
    }
  }

  return (
    <Flex direction="column" gap="4">
      <Flex gap="3" wrap="wrap">
        <Button
          variant="soft"
          disabled={loading || revoking}
          onClick={() => {
            setFeedback("")
            setQuery((value) => ({ ...value }))
          }}
        >
          Refresh
        </Button>
        <Button ref={disconnectButton} variant="outline" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </Flex>
      {error && !selected && (
        <Text as="p" color="red" role="alert">
          {error}
        </Text>
      )}
      <Text as="p" role="status">
        {feedback || (loading ? "Loading morsels…" : "")}
      </Text>
      <AlertDialog.Root
        open={selected != null}
        onOpenChange={(open) => {
          if (!open && !revoking) setSelected(undefined)
        }}
      >
        <AlertDialog.Content
          maxWidth="28rem"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const trigger = revokeTrigger.current
            if (trigger?.isConnected && !trigger.disabled) trigger.focus()
            else disconnectButton.current?.focus()
          }}
        >
          <AlertDialog.Title>Revoke this morsel?</AlertDialog.Title>
          <AlertDialog.Description>
            This permanently disables the share link. Cached copies cannot be removed.
          </AlertDialog.Description>
          <Text as="p" mt="3" className="management-excerpt">
            {selected?.title || selected?.excerpt || selected?.id}
          </Text>
          {error && (
            <Text as="p" color="red" role="alert">
              {error}
            </Text>
          )}
          <Flex gap="3" mt="4" wrap="wrap" justify="end">
            <AlertDialog.Cancel>
              <Button variant="soft" disabled={revoking}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button color="red" disabled={revoking} onClick={() => void confirmRevocation()}>
              {revoking ? "Revoking…" : "Confirm revoke"}
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
      {page && (
        <>
          {page.items.length === 0 && (
            <Text as="p">{offset === 0 ? "No morsels yet." : "No morsels on this page."}</Text>
          )}
          <ul className="management-list" aria-label="Morsels">
            {page.items.map((share) => (
              <li key={share.id}>
                <Card className="management-card">
                  <Flex direction="column" gap="3">
                    <Flex justify="between" align="start" gap="3" wrap="wrap">
                      <Heading as="h2" size="4">
                        {share.title || "Untitled morsel"}
                      </Heading>
                      <Badge color={share.status === "active" ? "green" : "gray"}>
                        {statusLabels[share.status]}
                      </Badge>
                    </Flex>
                    <Text as="p" className="management-excerpt">
                      {share.excerpt}
                    </Text>
                    <Text as="p" size="1" color="gray">
                      ID: {share.id}
                    </Text>
                    <Flex gap="3" wrap="wrap">
                      <Text size="2">Created {date(share.created_at)}</Text>
                      <Text size="2">
                        Views: {share.view_count}
                        {share.max_views != null ? ` / ${share.max_views}` : " / unlimited"}
                      </Text>
                      <Text size="2">
                        {share.expires_at ? `Expires ${date(share.expires_at)}` : "No expiration"}
                      </Text>
                      {share.revoked_at && <Text size="2">Revoked {date(share.revoked_at)}</Text>}
                    </Flex>
                    <Flex>
                      <Button
                        color="red"
                        variant="soft"
                        disabled={revoking || share.status === "revoked"}
                        aria-label={`Revoke ${share.title || share.id}`}
                        onClick={(event) => {
                          revokeTrigger.current = event.currentTarget
                          setSelected(share)
                          setError("")
                          setFeedback("")
                        }}
                      >
                        Revoke
                      </Button>
                    </Flex>
                  </Flex>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      <Flex asChild gap="3" align="center" wrap="wrap">
        <nav aria-label="Morsel pages">
          <Button
            variant="soft"
            disabled={loading || revoking || offset === 0}
            onClick={() => setQuery({ offset: Math.max(0, offset - 50) })}
          >
            Previous
          </Button>
          <Text size="2">Page {Math.floor(offset / 50) + 1}</Text>
          <Button
            variant="soft"
            disabled={loading || revoking || page?.next_offset == null}
            onClick={() => {
              if (page?.next_offset != null) setQuery({ offset: page.next_offset })
            }}
          >
            Next
          </Button>
        </nav>
      </Flex>
    </Flex>
  )
}

export function ManagePage() {
  const [apiKey, setApiKey] = useState("")
  const [unauthorized, setUnauthorized] = useState(false)
  const disconnect = useCallback((invalid = false) => {
    setApiKey("")
    setUnauthorized(invalid)
  }, [])

  useEffect(() => {
    const clear = () => disconnect()
    window.addEventListener("pagehide", clear)
    return () => window.removeEventListener("pagehide", clear)
  }, [disconnect])

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const key = String(new FormData(form).get("api-key") ?? "").trim()
    if (!key) return
    form.reset()
    setUnauthorized(false)
    setApiKey(key)
  }

  return (
    <section className="management-page" aria-labelledby="management-title">
      <Flex direction="column" gap="4">
        <Link href="/">← Morsel</Link>
        <Heading as="h1" id="management-title">
          Manage morsels
        </Heading>
        <Text as="p" color="gray">
          Review and revoke shares without consuming views. Original share URLs cannot be recovered.
        </Text>
        {apiKey ? (
          <ManagementSession apiKey={apiKey} disconnect={disconnect} />
        ) : (
          <Card>
            <form onSubmit={connect}>
              <Flex direction="column" gap="3">
                <Text as="p">Enter an API key to manage all shares on this server.</Text>
                <Text as="label" htmlFor="api-key" size="2">
                  API key
                </Text>
                <TextField.Root
                  id="api-key"
                  name="api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  aria-describedby="api-key-help"
                />
                <Text as="p" id="api-key-help" size="2" color="gray">
                  The key stays in memory until you disconnect, leave this page, or reload.
                </Text>
                {unauthorized && (
                  <Text as="p" color="red" role="alert">
                    Invalid API key. Enter a valid key to retry.
                  </Text>
                )}
                <Flex>
                  <Button type="submit">Connect</Button>
                </Flex>
              </Flex>
            </form>
          </Card>
        )}
      </Flex>
    </section>
  )
}
