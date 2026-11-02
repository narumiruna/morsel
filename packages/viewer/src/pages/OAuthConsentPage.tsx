import { Button, Card, Flex, Heading, Text } from "@radix-ui/themes"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useAccountSession } from "../account/AccountSession"
import {
  type Account,
  AccountError,
  accountErrorMessage,
  accountRequest,
  authenticate,
  checkAccount,
  supportsPasskeys,
} from "../account/accountApi"
import {
  consentRequestHandle,
  invalidOAuthRequest,
  isOAuthCallback,
  type OAuthRequest,
} from "../account/oauth"
import "../account/oauth.css"
import { AppHeader } from "../components/AppHeader"
import { formatDate } from "../formatDate"
import { LoadingPage } from "./StatusPage"

export function OAuthConsentPage({ search, hash }: { search: string; hash: string }) {
  const { account, expectedAccount, expire } = useAccountSession()
  const handle = hash ? null : consentRequestHandle(search)
  const [request, setRequest] = useState<OAuthRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [invalid, setInvalid] = useState(!handle)
  const [completed, setCompleted] = useState(false)
  const [error, setError] = useState("")
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [supported] = useState(supportsPasskeys)
  const controller = useRef<AbortController | null>(null)
  const locked = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)

  useLayoutEffect(() => () => controller.current?.abort(), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries only the GET, never a decision.
  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    locked.current = false
    const { signal } = abort
    setRequest(null)
    setBusy(false)
    setStatus("")
    setError("")
    setInvalid(!handle)
    setCompleted(false)
    setLoading(!!handle)
    if (handle) {
      void accountRequest<OAuthRequest>(`account/oauth/requests/${handle}`, {
        signal,
        expectedAccount,
      })
        .then((result) => {
          signal.throwIfAborted()
          checkAccount(expectedAccount, result.account_id ?? "")
          if (
            !["mcp:shares", "mcp:shares offline_access"].includes(result.scope) ||
            !Number.isFinite(Date.parse(result.expires_at)) ||
            Date.parse(result.expires_at) <= Date.now()
          ) {
            setInvalid(true)
            return
          }
          setRequest(result)
        })
        .catch((failure: unknown) => {
          if (signal.aborted || !expectedAccount.isCurrent()) return
          if (failure instanceof AccountError && failure.status === 401) expire()
          else if (failure instanceof AccountError && failure.code === "oauth_request_invalid")
            setInvalid(true)
          else setError(accountErrorMessage(failure))
        })
        .finally(() => {
          if (!signal.aborted) setLoading(false)
        })
    }
    return () => abort.abort()
  }, [handle, expectedAccount, expire, revision])

  useEffect(() => {
    if (!request) return
    const timer = window.setTimeout(
      () => {
        controller.current?.abort()
        setInvalid(true)
        setRequest(null)
        setBusy(false)
        setStatus("")
      },
      Math.max(0, Date.parse(request.expires_at) - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [request])

  useEffect(() => {
    if (!loading) heading.current?.focus()
  }, [loading])

  const decide = async (approve: boolean) => {
    const signal = controller.current?.signal
    if (locked.current || !signal || signal.aborted || !request || invalid || completed || !handle)
      return
    if (Date.parse(request.expires_at) <= Date.now()) {
      setInvalid(true)
      return
    }
    locked.current = true
    setBusy(true)
    setError("")
    setStatus("Checking account…")
    let decided = false
    const check = () => {
      signal.throwIfAborted()
      checkAccount(expectedAccount)
      if (
        window.location.pathname !== "/oauth/consent" ||
        window.location.search !== search ||
        window.location.hash
      )
        throw new DOMException("Connection request changed", "AbortError")
    }
    try {
      const current = await accountRequest<Account>("account", { signal, expectedAccount })
      check()
      const csrf = current.csrf_token
      if (!current.authenticated || !csrf)
        throw new AccountError(401, "session_expired", "Your session expired.")
      if (approve && current.verification_required !== false) {
        setStatus("Verify your passkey to approve access. Complete the prompt, or cancel to stop.")
        await authenticate("verify", {}, csrf, signal, expectedAccount)
        check()
      }
      check()
      setStatus(approve ? "Approving access…" : "Denying access…")
      // This callback is one-use data. Never retain it in state, storage, history, or an event.
      const { redirect_url: redirectURL } = await accountRequest<{ redirect_url: string }>(
        `account/oauth/requests/${handle}`,
        {
          method: "POST",
          body: { approve, account_id: request.account_id },
          csrf,
          signal,
          expectedAccount,
        },
      )
      decided = true
      check()
      if (!isOAuthCallback(redirectURL)) throw new Error("Invalid OAuth callback")
      const finalAccount = await accountRequest<Account>("account", { signal, expectedAccount })
      if (!finalAccount.authenticated)
        throw new AccountError(401, "session_expired", "Your session expired.")
      // No await is allowed between these checks and the external navigation.
      check()
      window.location.replace(redirectURL)
      setCompleted(true)
      setRequest(null)
    } catch (failure) {
      if (
        signal.aborted ||
        !expectedAccount.isCurrent() ||
        (failure instanceof DOMException && failure.name === "AbortError")
      )
        return
      if (failure instanceof AccountError && failure.status === 401) expire()
      else if (
        decided ||
        (failure instanceof AccountError && failure.code === "oauth_request_invalid")
      ) {
        setRequest(null)
        setInvalid(true)
      } else setError(accountErrorMessage(failure))
    } finally {
      if (controller.current?.signal === signal) {
        locked.current = false
        if (!signal.aborted) {
          setBusy(false)
          setStatus("")
        }
      }
    }
  }

  return (
    <>
      <AppHeader />
      <main className="app-shell">
        <div className="account-page">
          <Heading as="h1" tabIndex={-1} ref={heading}>
            Connect app
          </Heading>
          <Text as="p" className="management-identity">
            Account: {account.display_name}
          </Text>
          <Text as="p" className="management-account-id">
            Account ID: <code>{account.account_id}</code>
          </Text>
          {loading ? (
            <LoadingPage subject="connection request" />
          ) : completed ? (
            <Text as="p" role="status">
              Returning to app…
            </Text>
          ) : invalid ? (
            <Text as="p" role="alert">
              {invalidOAuthRequest}
            </Text>
          ) : (
            <>
              {error && (
                <Text as="p" role="alert">
                  {error}
                </Text>
              )}
              <Text as="p" role="status">
                {status}
              </Text>
              {!request ? (
                <Button onClick={() => setRevision((value) => value + 1)}>Retry request</Button>
              ) : (
                <Card>
                  <Heading as="h2" size="5">
                    Review app access
                  </Heading>
                  <Text as="p">
                    The app name is unverified. It does not prove who operates this app. Approve
                    only if you started this connection and trust the app.
                  </Text>
                  <dl className="oauth-details">
                    <dt>Unverified app name</dt>
                    <dd>{request.client_name}</dd>
                    <dt>Client ID</dt>
                    <dd>
                      <code>{request.client_id}</code>
                    </dd>
                    <dt>Redirect host</dt>
                    <dd>
                      <code>{request.redirect_host}</code>
                    </dd>
                    <dt>Resource</dt>
                    <dd>
                      <code>{request.resource}</code>
                    </dd>
                    <dt>Scope</dt>
                    <dd>
                      <code>{request.scope}</code>
                    </dd>
                  </dl>
                  <Heading as="h3" size="4">
                    Share permissions
                  </Heading>
                  <ul className="oauth-permissions">
                    <li>
                      Create Markdown shares (<code>create_share</code>). Anyone with a share link
                      can read it.
                    </li>
                    <li>
                      Read shares with a share token (<code>get_share</code>). Each read consumes
                      one view. A valid token can read a share from any account.
                    </li>
                    <li>
                      Revoke shares owned by this account (<code>revoke_share</code>).
                    </li>
                  </ul>
                  <Text as="p">
                    This app cannot manage your account, passkeys, or connected apps.
                  </Text>
                  <Text as="p">
                    {request.scope === "mcp:shares offline_access"
                      ? "Persistent access: up to 30 days, including when you are signed out. Access tokens expire after 10 minutes. Revoke access in Connected apps."
                      : "Access tokens expire after 10 minutes. No persistent access was requested."}
                  </Text>
                  <Text as="p">Request expires {formatDate(request.expires_at)}.</Text>
                  <Text as="p">Approval can require passkey verification. Denial does not.</Text>
                  {!supported && account.verification_required !== false && (
                    <Text as="p" role="note">
                      This browser does not support passkeys. You can still deny access.
                    </Text>
                  )}
                  <Flex gap="3" wrap="wrap">
                    <Button
                      disabled={busy || (!supported && account.verification_required !== false)}
                      onClick={() => void decide(true)}
                    >
                      Approve access
                    </Button>
                    <Button variant="soft" disabled={busy} onClick={() => void decide(false)}>
                      Deny access
                    </Button>
                  </Flex>
                </Card>
              )}
            </>
          )}
        </div>
      </main>
    </>
  )
}
