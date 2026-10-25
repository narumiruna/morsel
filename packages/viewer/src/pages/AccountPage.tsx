import { Button, Card, Flex, Heading, Text } from "@radix-ui/themes"
import { useCallback, useEffect, useRef, useState } from "react"
import { useAccountSession } from "../account/AccountSession"
import {
  type Account,
  AccountError,
  type APIKey,
  accountErrorMessage,
  accountRequest,
  authenticate,
  type Passkey,
  supportsPasskeys,
} from "../account/accountApi"
import {
  type AccountMutation,
  initialShareListState,
  type ShareListState,
  ShareManagement,
} from "../account/ShareManagement"
import { AppHeader } from "../components/AppHeader"
import { formatDate } from "../formatDate"
import { useKeyDiscardWarning } from "../navigation"
import { LoadingPage } from "./StatusPage"

export type AccountSection = "security" | "shares" | "api-keys"

const sections = [
  { section: "shares", href: "/manage/shares", label: "Shares" },
  { section: "api-keys", href: "/manage/api-keys", label: "API keys" },
  { section: "security", href: "/account", label: "Security" },
] as const

export function AccountPage({ section = "security" }: { section?: AccountSection }) {
  const {
    account,
    setAccount,
    refresh,
    expire,
    signedOut,
    notice: sessionNotice,
  } = useAccountSession()
  const loadedSection = useRef(section)
  const [passkeys, setPasskeys] = useState<Passkey[]>([])
  const [keys, setKeys] = useState<APIKey[]>([])
  const [listError, setListError] = useState("")
  const [shareListState, setShareListState] = useState<ShareListState>(initialShareListState)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [busyAction, setBusyAction] = useState("")
  const [revokeKey, setRevokeKey] = useState<APIKey | null>(null)
  const revokeTrigger = useRef<HTMLButtonElement | null>(null)
  const cancelRevoke = useRef<HTMLButtonElement | null>(null)
  const keyHeading = useRef<HTMLHeadingElement | null>(null)
  const saveKeyHeading = useRef<HTMLHeadingElement | null>(null)
  const [removePasskey, setRemovePasskey] = useState<Passkey | null>(null)
  const removeTrigger = useRef<HTMLButtonElement | null>(null)
  const cancelRemove = useRef<HTMLButtonElement | null>(null)
  const passkeyHeading = useRef<HTMLHeadingElement | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState(sessionNotice)
  const [passkeyName, setPasskeyName] = useState("")
  const [keyName, setKeyName] = useState("")
  const [rawKey, setRawKey] = useState<string | null>(null)
  const [supported] = useState(supportsPasskeys)
  const controller = useRef<AbortController | null>(null)
  const locked = useRef(false)
  useKeyDiscardWarning(rawKey)

  useEffect(() => {
    if (revokeKey) cancelRevoke.current?.focus()
  }, [revokeKey])

  useEffect(() => {
    if (rawKey) saveKeyHeading.current?.focus()
  }, [rawKey])

  useEffect(() => {
    if (removePasskey) cancelRemove.current?.focus()
  }, [removePasskey])

  const forgetSession = useCallback(() => {
    controller.current?.abort()
    expire()
  }, [expire])

  const expireShareSession = forgetSession

  const refreshLists = useCallback(
    async (signal: AbortSignal) => {
      try {
        if (section === "security") {
          const next = await accountRequest<Passkey[]>("passkeys", { signal })
          if (!signal.aborted) setPasskeys(next)
        } else if (section === "api-keys") {
          const next = await accountRequest<APIKey[]>("api-keys", { signal })
          if (!signal.aborted) setKeys(next)
        }
        if (!signal.aborted) setListError("")
      } catch (failure) {
        if (signal.aborted) return
        if (failure instanceof AccountError && failure.status === 401) throw failure
        setListError(accountErrorMessage(failure))
      }
    },
    [section],
  )

  const refreshAccount = useCallback(
    async (signal: AbortSignal) => {
      const next = await refresh(signal)
      if (!next.authenticated) {
        forgetSession()
        return
      }
      await refreshLists(signal)
    },
    [refresh, refreshLists, forgetSession],
  )

  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    locked.current = false
    setBusy(false)
    setLoading(true)
    setRawKey(null)
    setRevokeKey(null)
    setRemovePasskey(null)
    setListError("")
    setKeys([])
    setPasskeys([])
    setKeyName("")
    setPasskeyName("")
    setError("")
    const changed = loadedSection.current !== section
    loadedSection.current = section
    if (changed) setNotice("")
    const load = changed ? refreshAccount : refreshLists
    void load(abort.signal)
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return
        if (failure instanceof AccountError && failure.status === 401) forgetSession()
        setError(accountErrorMessage(failure))
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false)
      })
    return () => {
      abort.abort()
      controller.current?.abort()
    }
  }, [forgetSession, refreshAccount, refreshLists, section])

  const run = async (
    action: (signal: AbortSignal) => Promise<void>,
    label = "Loading account…",
  ) => {
    if (locked.current) return false
    const signal = controller.current?.signal
    if (!signal || signal.aborted) return false
    locked.current = true
    setBusy(true)
    setBusyAction(label)
    setError("")
    setNotice("")
    try {
      await action(signal)
      return !signal.aborted
    } catch (failure) {
      if (signal.aborted) return false
      if (failure instanceof AccountError) {
        if (failure.status === 401) forgetSession()
        if (failure.status === 403 || failure.status === 409) {
          try {
            await refreshAccount(signal)
          } catch (refreshFailure) {
            if (
              !signal.aborted &&
              refreshFailure instanceof AccountError &&
              refreshFailure.status === 401
            ) {
              forgetSession()
            }
          }
        }
      }
      if (!signal.aborted || (failure instanceof AccountError && failure.status === 401)) {
        setError(accountErrorMessage(failure))
      }
      return false
    } finally {
      if (controller.current?.signal === signal) {
        locked.current = false
        if (!signal.aborted) setBusy(false)
      }
    }
  }

  const mutateAction = (action: Parameters<AccountMutation>[0], label: string) => {
    return run(async (signal) => {
      const current = await accountRequest<Account>("account", { signal })
      if (signal.aborted) return
      setAccount(current)
      const csrf = current.csrf_token
      if (!current.authenticated || !csrf)
        throw new AccountError(401, "session_expired", "Your session expired.")
      if (current.verification_required !== false) {
        setBusyAction(
          `Verify your passkey to continue: ${label} Complete the passkey prompt, or cancel to stop.`,
        )
        await authenticate("verify", {}, csrf, signal)
      }
      if (signal.aborted) return
      setBusyAction(label)
      await action(signal, csrf)
      if (!signal.aborted) await refreshLists(signal)
    }, label)
  }

  const mutate: AccountMutation = (action) => mutateAction(action, "Revoking share…")

  const logout = () => {
    controller.current?.abort()
    controller.current = new AbortController()
    locked.current = false
    setRawKey(null)
    setRevokeKey(null)
    setRemovePasskey(null)
    void run(async (signal) => {
      await accountRequest("auth/logout", {
        method: "POST",
        body: {},
        csrf: account?.csrf_token,
        signal,
      })
      if (signal.aborted) return
      signedOut()
    }, "Signing out…")
  }

  return (
    <>
      <AppHeader
        authenticated={account?.authenticated}
        busy={busyAction === "Signing out…" && busy}
        onLogout={logout}
      />
      <main className="app-shell">
        {loading ? (
          <LoadingPage subject="account" />
        ) : (
          <div className={`account-page${section === "shares" ? " management-shell" : ""}`}>
            <Heading as="h1">
              {section === "security"
                ? "Morsel account"
                : section === "shares"
                  ? "Manage shares"
                  : "Manage API keys"}
            </Heading>
            <nav className="management-navigation" aria-label="Management sections">
              {sections.map((item) => (
                <a
                  key={item.section}
                  href={item.href}
                  aria-current={section === item.section ? "page" : undefined}
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div role="alert" className="account-error">
              {error}
            </div>
            <div role="status" aria-live="polite">
              {busy ? busyAction : notice}
            </div>
            {!supported && (
              <Text as="p" color="red">
                This browser does not support passkeys. Use a browser with WebAuthn support on HTTPS
                or localhost.
              </Text>
            )}
            {section === "api-keys" && rawKey && (
              <Card className="account-secret">
                <Heading as="h2" size="4" tabIndex={-1} ref={saveKeyHeading}>
                  Save your new API key
                </Heading>
                <Text as="p" id="new-api-key-warning">
                  This key is shown only once. Copy it now. You cannot recover it after you dismiss
                  it.
                </Text>
                <label htmlFor="new-api-key">New API key</label>
                <input
                  id="new-api-key"
                  aria-describedby="new-api-key-warning"
                  readOnly
                  value={rawKey}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Flex gap="3" wrap="wrap">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async (signal) => {
                        try {
                          await navigator.clipboard.writeText(rawKey)
                          if (!signal.aborted) setNotice("API key copied.")
                        } catch {
                          if (!signal.aborted)
                            setError("Could not copy API key. Select and copy it manually.")
                        }
                      }, "Copying API key…")
                    }
                  >
                    Copy API key
                  </Button>
                  <Button
                    variant="soft"
                    disabled={busy}
                    onClick={() => {
                      setRawKey(null)
                      setNotice("")
                      keyHeading.current?.focus()
                    }}
                  >
                    Dismiss API key
                  </Button>
                </Flex>
              </Card>
            )}
            {section === "shares" && (
              <ShareManagement
                busy={busy}
                canVerify={supported}
                mutate={mutate}
                onSessionExpired={expireShareSession}
                controls={shareListState}
                onControlsChange={setShareListState}
              />
            )}
            {section === "api-keys" && (
              <Card>
                <Heading as="h2" size="5" tabIndex={-1} ref={keyHeading}>
                  API keys
                </Heading>
                <Text as="p">
                  API keys can create and revoke shares. They cannot manage your account. Account
                  changes require passkey verification within the last 12 hours.
                </Text>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (rawKey) return
                    void mutateAction(async (signal, csrf) => {
                      const result = await accountRequest<APIKey & { key: string }>("api-keys", {
                        method: "POST",
                        body: { name: keyName.trim() },
                        csrf,
                        signal,
                      })
                      if (signal.aborted) return
                      setRawKey(result.key)
                      setKeyName("")
                      setNotice("API key created. Save it now; it is shown only once.")
                    }, "Creating API key…")
                  }}
                >
                  {rawKey && (
                    <Text as="p" id="create-key-blocked">
                      Save and dismiss your new API key before you create another key.
                    </Text>
                  )}
                  <fieldset
                    disabled={busy || !supported || rawKey !== null}
                    aria-describedby={rawKey ? "create-key-blocked" : undefined}
                  >
                    <label htmlFor="api-key-name">API key name</label>
                    <input
                      id="api-key-name"
                      required
                      maxLength={100}
                      value={keyName}
                      onChange={(event) => setKeyName(event.target.value)}
                    />
                    <Button type="submit" disabled={!keyName.trim()}>
                      Create API key
                    </Button>
                  </fieldset>
                </form>
                {listError ? (
                  <>
                    <Text as="p" role="alert">
                      Could not load API keys. {listError}
                    </Text>
                    <Button
                      disabled={busy}
                      onClick={() => void run(refreshLists, "Loading API keys…")}
                    >
                      Retry API keys
                    </Button>
                  </>
                ) : keys.length === 0 ? (
                  <Text as="p">No API keys.</Text>
                ) : (
                  <ul className="account-list">
                    {keys.map((key) => (
                      <li key={key.id}>
                        <div>
                          <strong>{key.name}</strong> <code>{key.prefix}</code>
                          <Text as="p" size="2">
                            Created {formatDate(key.created_at)}
                            {key.revoked_at ? ` · Revoked ${formatDate(key.revoked_at)}` : ""}
                          </Text>
                        </div>
                        {!key.revoked_at && (
                          <Button
                            color="red"
                            variant="soft"
                            disabled={busy || !supported}
                            aria-label={`Revoke API key ${key.name}`}
                            onClick={(event) => {
                              revokeTrigger.current = event.currentTarget
                              setRevokeKey(key)
                            }}
                          >
                            Revoke
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {revokeKey && (
                  <section aria-labelledby="revoke-key-title" className="share-confirmation">
                    <Heading as="h3" size="4" id="revoke-key-title">
                      Revoke API key {revokeKey.name}?
                    </Heading>
                    <Text as="p">
                      <strong>{revokeKey.name}</strong> <code>{revokeKey.prefix}</code>
                    </Text>
                    <Text as="p">
                      Integrations using this key will lose access. This cannot be undone. Existing
                      shares remain available and are not changed.
                    </Text>
                    <Text as="p">If required by the server, verify your passkey to continue.</Text>
                    <Flex gap="3" wrap="wrap">
                      <Button
                        color="red"
                        disabled={busy || !supported || !!listError}
                        onClick={() => {
                          const key = revokeKey
                          void mutateAction(async (signal, csrf) => {
                            await accountRequest(`api-keys/${encodeURIComponent(key.id)}`, {
                              method: "DELETE",
                              csrf,
                              signal,
                            })
                            if (signal.aborted) return
                            setRevokeKey(null)
                            setNotice("API key revoked. Existing shares are unchanged.")
                          }, "Revoking API key…").then((success) => {
                            if (success) keyHeading.current?.focus()
                          })
                        }}
                      >
                        Confirm revoke API key
                      </Button>
                      <Button
                        variant="soft"
                        ref={cancelRevoke}
                        disabled={busy}
                        onClick={() => {
                          setRevokeKey(null)
                          const trigger = revokeTrigger.current
                          if (trigger?.isConnected && !trigger.disabled) trigger.focus()
                          else keyHeading.current?.focus()
                        }}
                      >
                        Cancel
                      </Button>
                    </Flex>
                  </section>
                )}
              </Card>
            )}
            {section === "security" && (
              <Card>
                <Heading as="h2" size="5" tabIndex={-1} ref={passkeyHeading}>
                  Passkeys
                </Heading>
                <Text as="p">Add a backup passkey. You must keep at least one passkey.</Text>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void mutateAction(async (signal, csrf) => {
                      setBusyAction("Registering passkey… Complete the passkey prompt.")
                      await authenticate("passkey", { name: passkeyName.trim() }, csrf, signal)
                      if (signal.aborted) return
                      setPasskeyName("")
                      setNotice("Passkey added.")
                    }, "Adding passkey…")
                  }}
                >
                  <fieldset disabled={busy || !supported}>
                    <label htmlFor="backup-passkey-name">Passkey name</label>
                    <input
                      id="backup-passkey-name"
                      required
                      maxLength={100}
                      value={passkeyName}
                      onChange={(event) => setPasskeyName(event.target.value)}
                    />
                    <Button type="submit" disabled={!passkeyName.trim()}>
                      Add passkey
                    </Button>
                  </fieldset>
                </form>
                {listError ? (
                  <>
                    <Text as="p" role="alert">
                      Could not load passkeys. {listError}
                    </Text>
                    <Button
                      disabled={busy}
                      onClick={() => void run(refreshLists, "Loading passkeys…")}
                    >
                      Retry passkeys
                    </Button>
                  </>
                ) : passkeys.length === 0 ? (
                  <Text as="p">No passkeys.</Text>
                ) : (
                  <ul className="account-list">
                    {passkeys.map((passkey) => (
                      <li key={passkey.id}>
                        <div>
                          <strong>{passkey.name}</strong>
                          <Text as="p" size="2">
                            Created {formatDate(passkey.created_at)}
                          </Text>
                        </div>
                        <Button
                          color="red"
                          variant="soft"
                          disabled={busy || !supported || passkeys.length <= 1}
                          aria-label={`Remove passkey ${passkey.name}`}
                          aria-describedby={
                            passkeys.length <= 1 ? "last-passkey-reason" : undefined
                          }
                          onClick={(event) => {
                            removeTrigger.current = event.currentTarget
                            setRemovePasskey(passkey)
                          }}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {!listError && passkeys.length === 1 && (
                  <Text as="p" id="last-passkey-reason">
                    You cannot remove your last passkey. Add a backup passkey first.
                  </Text>
                )}
                {removePasskey && (
                  <section aria-labelledby="remove-passkey-title" className="share-confirmation">
                    <Heading as="h3" size="4" id="remove-passkey-title">
                      Remove passkey {removePasskey.name}?
                    </Heading>
                    <Text as="p">
                      You will no longer be able to sign in with this passkey. Keep another passkey
                      that you can use to sign in. This cannot be undone.
                    </Text>
                    <Text as="p">If required by the server, verify your passkey to continue.</Text>
                    <Flex gap="3" wrap="wrap">
                      <Button
                        color="red"
                        disabled={
                          busy ||
                          !supported ||
                          !!listError ||
                          passkeys.length <= 1 ||
                          !passkeys.some((passkey) => passkey.id === removePasskey.id)
                        }
                        onClick={() => {
                          const passkey = removePasskey
                          void mutateAction(async (signal, csrf) => {
                            await accountRequest(`passkeys/${encodeURIComponent(passkey.id)}`, {
                              method: "DELETE",
                              csrf,
                              signal,
                            })
                            if (signal.aborted) return
                            setRemovePasskey(null)
                            setNotice("Passkey removed.")
                          }, "Removing passkey…").then((success) => {
                            if (success) passkeyHeading.current?.focus()
                          })
                        }}
                      >
                        Confirm remove passkey
                      </Button>
                      <Button
                        variant="soft"
                        ref={cancelRemove}
                        disabled={busy}
                        onClick={() => {
                          setRemovePasskey(null)
                          const trigger = removeTrigger.current
                          if (trigger?.isConnected && !trigger.disabled) trigger.focus()
                          else passkeyHeading.current?.focus()
                        }}
                      >
                        Cancel
                      </Button>
                    </Flex>
                  </section>
                )}
              </Card>
            )}
          </div>
        )}
      </main>
    </>
  )
}
