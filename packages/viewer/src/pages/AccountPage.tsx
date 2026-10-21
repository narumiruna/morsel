import { Button, Card, Flex, Heading, Link, Text } from "@radix-ui/themes"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  type Account,
  AccountError,
  type APIKey,
  type AuthOperation,
  accountErrorMessage,
  accountRequest,
  authenticate,
  type Passkey,
  supportsPasskeys,
} from "../account/accountApi"
import { LoadingPage } from "./StatusPage"

export function AccountPage() {
  const [account, setAccount] = useState<Account | null>(null)
  const [passkeys, setPasskeys] = useState<Passkey[]>([])
  const [keys, setKeys] = useState<APIKey[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [token, setToken] = useState("")
  const [passkeyName, setPasskeyName] = useState("")
  const [keyName, setKeyName] = useState("")
  const [rawKey, setRawKey] = useState<string | null>(null)
  const [supported] = useState(supportsPasskeys)
  const controller = useRef<AbortController | null>(null)
  const locked = useRef(false)

  const forgetSession = useCallback(() => {
    setRawKey(null)
    setKeys([])
    setPasskeys([])
    setToken("")
    setAccount({ setup_required: false, authenticated: false })
  }, [])

  const refreshLists = useCallback(async (signal: AbortSignal) => {
    const [nextPasskeys, nextKeys] = await Promise.all([
      accountRequest<Passkey[]>("passkeys", { signal }),
      accountRequest<APIKey[]>("api-keys", { signal }),
    ])
    if (signal.aborted) return
    setPasskeys(nextPasskeys)
    setKeys(nextKeys)
  }, [])

  const refreshAccount = useCallback(
    async (signal: AbortSignal) => {
      const next = await accountRequest<Account>("account", { signal })
      if (signal.aborted) return
      setAccount(next)
      if (!next.authenticated) {
        setRawKey(null)
        setKeys([])
        setPasskeys([])
      }
      if (next.authenticated) await refreshLists(signal)
    },
    [refreshLists],
  )

  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    refreshAccount(abort.signal)
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return
        if (failure instanceof AccountError && failure.status === 401) forgetSession()
        setError(accountErrorMessage(failure))
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false)
      })
    return () => abort.abort()
  }, [forgetSession, refreshAccount])

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (locked.current) return
    const signal = controller.current?.signal
    if (!signal || signal.aborted) return
    locked.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await action(signal)
    } catch (failure) {
      if (signal.aborted) return
      if (failure instanceof AccountError) {
        if (failure.status === 401) forgetSession()
        if (failure.status === 403 || failure.status === 409) {
          try {
            await refreshAccount(signal)
          } catch (refreshFailure) {
            if (refreshFailure instanceof AccountError && refreshFailure.status === 401) {
              forgetSession()
            }
          }
        }
      }
      if (!signal.aborted) setError(accountErrorMessage(failure))
    } finally {
      locked.current = false
      if (!signal.aborted) setBusy(false)
    }
  }

  const signIn = (operation: AuthOperation) => {
    const body = operation === "login" ? {} : { token, name: passkeyName.trim() }
    setToken("")
    void run(async (signal) => {
      await authenticate(operation, body, undefined, signal)
      await refreshAccount(signal)
      setPasskeyName("")
      setNotice(
        operation === "recover"
          ? "Account recovered. Review your API keys and revoke any compromised keys."
          : "Signed in.",
      )
    })
  }

  const mutate = (action: (signal: AbortSignal, csrf: string) => Promise<void>) => {
    void run(async (signal) => {
      const current = await accountRequest<Account>("account", { signal })
      if (signal.aborted) return
      setAccount(current)
      const csrf = current.csrf_token
      if (!current.authenticated || !csrf)
        throw new AccountError(401, "session_expired", "Your session expired.")
      if (current.verification_required !== false) {
        await authenticate("verify", {}, csrf, signal)
      }
      await action(signal, csrf)
      await refreshLists(signal)
    })
  }

  if (loading) return <LoadingPage subject="account" />

  return (
    <div className="account-page">
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Heading as="h1">Morsel account</Heading>
        <Link href="/">Home</Link>
      </Flex>
      <div role="alert" className="account-error">
        {error}
      </div>
      <div role="status" aria-live="polite">
        {busy ? "Working… Complete the passkey prompt, or cancel it to stop." : notice}
      </div>
      {!account ? (
        <Button disabled={busy} onClick={() => void run((signal) => refreshAccount(signal))}>
          Retry account
        </Button>
      ) : (
        <>
          {!supported && (
            <Text as="p" color="red">
              This browser does not support passkeys. Use a browser with WebAuthn support on HTTPS
              or localhost.
            </Text>
          )}
          {account.authenticated ? (
            <>
              <Button
                variant="soft"
                disabled={busy}
                onClick={() => {
                  setRawKey(null)
                  void run(async (signal) => {
                    await accountRequest("auth/logout", {
                      method: "POST",
                      body: {},
                      csrf: account.csrf_token,
                      signal,
                    })
                    forgetSession()
                    setNotice("Signed out.")
                  })
                }}
              >
                Log out
              </Button>
              {rawKey && (
                <Card className="account-secret">
                  <Heading as="h2" size="4">
                    Save your new API key
                  </Heading>
                  <Text as="p">
                    This key is shown only once. Copy it now. You cannot recover it after you
                    dismiss it.
                  </Text>
                  <label htmlFor="new-api-key">New API key</label>
                  <input
                    id="new-api-key"
                    readOnly
                    value={rawKey}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Flex gap="3" wrap="wrap">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await navigator.clipboard.writeText(rawKey)
                          setNotice("API key copied.")
                        })
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
                      }}
                    >
                      Dismiss API key
                    </Button>
                  </Flex>
                </Card>
              )}
              <Card>
                <Heading as="h2" size="5">
                  API keys
                </Heading>
                <Text as="p">
                  API keys can create and revoke shares. They cannot manage your account. Account
                  changes require passkey verification within the last 12 hours.
                </Text>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    mutate(async (signal, csrf) => {
                      const result = await accountRequest<APIKey & { key: string }>("api-keys", {
                        method: "POST",
                        body: { name: keyName.trim() },
                        csrf,
                        signal,
                      })
                      if (signal.aborted) return
                      setRawKey(result.key)
                      setKeyName("")
                    })
                  }}
                >
                  <fieldset disabled={busy || !supported}>
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
                {keys.length === 0 ? (
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
                            onClick={() =>
                              mutate(async (signal, csrf) => {
                                await accountRequest(`api-keys/${encodeURIComponent(key.id)}`, {
                                  method: "DELETE",
                                  csrf,
                                  signal,
                                })
                                setNotice("API key revoked. Existing shares are unchanged.")
                              })
                            }
                          >
                            Revoke
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card>
                <Heading as="h2" size="5">
                  Passkeys
                </Heading>
                <Text as="p">Add a backup passkey. You must keep at least one passkey.</Text>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    mutate(async (signal, csrf) => {
                      await authenticate("passkey", { name: passkeyName.trim() }, csrf, signal)
                      setPasskeyName("")
                      setNotice("Passkey added.")
                    })
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
                        onClick={() =>
                          mutate(async (signal, csrf) => {
                            await accountRequest(`passkeys/${encodeURIComponent(passkey.id)}`, {
                              method: "DELETE",
                              csrf,
                              signal,
                            })
                            setNotice("Passkey removed.")
                          })
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          ) : (
            <>
              <Card>
                <Heading as="h2" size="5">
                  {account.setup_required ? "Set up account" : "Sign in"}
                </Heading>
                {account.setup_required ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      signIn("setup")
                    }}
                  >
                    <Text as="p">
                      Use the one-time setup token from the operator command to register your first
                      passkey.
                    </Text>
                    <fieldset disabled={busy || !supported}>
                      <label htmlFor="setup-token">Setup token</label>
                      <input
                        id="setup-token"
                        type="password"
                        autoComplete="off"
                        required
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                      />
                      <label htmlFor="setup-passkey-name">Passkey name</label>
                      <input
                        id="setup-passkey-name"
                        required
                        maxLength={100}
                        value={passkeyName}
                        onChange={(event) => setPasskeyName(event.target.value)}
                      />
                      <Button type="submit" disabled={!token.trim() || !passkeyName.trim()}>
                        Set up account
                      </Button>
                    </fieldset>
                  </form>
                ) : (
                  <Button disabled={busy || !supported} onClick={() => signIn("login")}>
                    Sign in with passkey
                  </Button>
                )}
              </Card>
              {!account.setup_required && (
                <Card>
                  <Heading as="h2" size="5">
                    Recover account
                  </Heading>
                  <Text as="p">
                    Use a one-time operator recovery token. Recovery replaces all passkeys and signs
                    out other sessions. Existing API keys stay active. Review and revoke keys after
                    recovery if you suspect compromise.
                  </Text>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      signIn("recover")
                    }}
                  >
                    <fieldset disabled={busy || !supported}>
                      <label htmlFor="recovery-token">Recovery token</label>
                      <input
                        id="recovery-token"
                        type="password"
                        autoComplete="off"
                        required
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                      />
                      <label htmlFor="recovery-passkey-name">Replacement passkey name</label>
                      <input
                        id="recovery-passkey-name"
                        required
                        maxLength={100}
                        value={passkeyName}
                        onChange={(event) => setPasskeyName(event.target.value)}
                      />
                      <Button type="submit" disabled={!token.trim() || !passkeyName.trim()}>
                        Recover account
                      </Button>
                    </fieldset>
                  </form>
                </Card>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
