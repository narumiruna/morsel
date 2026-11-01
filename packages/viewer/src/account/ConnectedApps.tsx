import { Button, Card, Flex, Heading, Text } from "@radix-ui/themes"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { formatDate } from "../formatDate"
import { useAccountSession } from "./AccountSession"
import { AccountError, accountErrorMessage, accountRequest, checkAccount } from "./accountApi"
import type { OAuthGrant } from "./oauth"
import "./oauth.css"
import type { AccountMutation } from "./ShareManagement"

export function ConnectedApps({
  busy,
  canVerify,
  mutate,
  sessionSignal,
}: {
  busy: boolean
  canVerify: boolean
  mutate: AccountMutation
  sessionSignal: AbortSignal
}) {
  const { expectedAccount, expire } = useAccountSession()
  const [grants, setGrants] = useState<OAuthGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<OAuthGrant | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const lifetime = useRef<AbortController | null>(null)
  const locked = useRef(false)

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true)
      try {
        const result = await accountRequest<OAuthGrant[]>("account/oauth/grants", {
          signal,
          expectedAccount,
        })
        signal.throwIfAborted()
        checkAccount(expectedAccount)
        setGrants(result)
        setError("")
      } catch (failure) {
        if (signal.aborted || !expectedAccount.isCurrent()) return
        if (failure instanceof AccountError && failure.status === 401) expire()
        else setError(accountErrorMessage(failure))
      } finally {
        if (!signal.aborted) setLoading(false)
      }
    },
    [expectedAccount, expire],
  )

  useLayoutEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries only the list GET.
  useEffect(() => {
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      sessionSignal,
      ...(lifetime.current ? [lifetime.current.signal] : []),
    ])
    void load(signal)
    return () => controller.abort()
  }, [load, sessionSignal, revision])

  useEffect(() => {
    if (selected) cancel.current?.focus()
  }, [selected])

  const revoke = async () => {
    const localSignal = lifetime.current?.signal
    if (!selected || locked.current || busy || !localSignal || localSignal.aborted) return
    locked.current = true
    const grant = selected
    try {
      const success = await mutate(async (parentSignal, csrf) => {
        const signal = AbortSignal.any([parentSignal, localSignal, sessionSignal])
        signal.throwIfAborted()
        checkAccount(expectedAccount)
        await accountRequest(`account/oauth/grants/${encodeURIComponent(grant.id)}`, {
          method: "DELETE",
          csrf,
          signal,
          expectedAccount,
        })
        signal.throwIfAborted()
        checkAccount(expectedAccount)
        setSelected(null)
        setNotice("App access revoked. Existing shares are unchanged.")
        // Keep the completed revocation separate from a failed list refresh.
        setGrants((current) =>
          current.map((item) =>
            item.id === grant.id ? { ...item, revoked_at: new Date().toISOString() } : item,
          ),
        )
        await load(signal)
      })
      if (success && !localSignal.aborted && !sessionSignal.aborted && expectedAccount.isCurrent())
        heading.current?.focus()
    } finally {
      locked.current = false
    }
  }

  return (
    <Card>
      <Heading as="h2" size="5" tabIndex={-1} ref={heading}>
        Connected apps
      </Heading>
      <Text as="p">
        These apps have access to share tools, not account settings. App names are unverified.
        Logging out does not revoke access. Revoke each connection separately.
      </Text>
      {notice && (
        <Text as="p" role="status">
          {notice}
        </Text>
      )}
      {error ? (
        <>
          <Text as="p" role="alert">
            Could not load connected apps. {error}
          </Text>
          <Button disabled={busy || loading} onClick={() => setRevision((value) => value + 1)}>
            Retry connected apps
          </Button>
        </>
      ) : loading ? (
        <Text as="p" role="status">
          Loading connected apps…
        </Text>
      ) : grants.length === 0 ? (
        <Text as="p">No connected apps.</Text>
      ) : null}
      {grants.length > 0 && (
        <ul className="account-list oauth-grants">
          {grants.map((grant) => (
            <li key={grant.id}>
              <div>
                <strong>{grant.client_name}</strong>
                <Text as="p" size="2">
                  Client ID: <code>{grant.client_id}</code>
                </Text>
                <Text as="p" size="2">
                  Connection ID: <code>{grant.id}</code>
                </Text>
                <Text as="p" size="2">
                  Resource: <code>{grant.resource}</code>
                </Text>
                <Text as="p" size="2">
                  Scope: <code>{grant.scope}</code>
                </Text>
                <Text as="p" size="2">
                  Created {formatDate(grant.created_at)} · Expires {formatDate(grant.expires_at)}
                  {grant.revoked_at ? ` · Revoked ${formatDate(grant.revoked_at)}` : ""}
                </Text>
              </div>
              {!grant.revoked_at && (
                <Button
                  color="red"
                  variant="soft"
                  disabled={busy || !canVerify || loading || !!error}
                  aria-label={`Revoke app ${grant.client_name} (${grant.id})`}
                  onClick={(event) => {
                    trigger.current = event.currentTarget
                    setNotice("")
                    setSelected(grant)
                  }}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <section aria-labelledby="revoke-app-title" className="share-confirmation">
          <Heading as="h3" size="4" id="revoke-app-title">
            Revoke app access?
          </Heading>
          <Text as="p">
            <strong>{selected.client_name}</strong>
          </Text>
          <Text as="p" className="management-account-id">
            Client ID: <code>{selected.client_id}</code>
          </Text>
          <Text as="p" className="management-account-id">
            Connection ID: <code>{selected.id}</code>
          </Text>
          <Text as="p">
            This connection will lose access. Other connections and existing shares are unchanged.
            This cannot be undone. Reconnect from the app if you need access again.
          </Text>
          <Text as="p">If required by the server, verify your passkey to continue.</Text>
          <Flex gap="3" wrap="wrap">
            <Button
              color="red"
              disabled={busy || !canVerify || loading || !!error}
              onClick={() => void revoke()}
            >
              Confirm revoke app
            </Button>
            <Button
              ref={cancel}
              variant="soft"
              disabled={busy}
              onClick={() => {
                setSelected(null)
                const button = trigger.current
                if (button?.isConnected && !button.disabled) button.focus()
                else heading.current?.focus()
              }}
            >
              Cancel
            </Button>
          </Flex>
        </section>
      )}
    </Card>
  )
}
