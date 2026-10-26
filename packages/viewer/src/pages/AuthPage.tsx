import { Button, Card, Heading, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { useAccountSession } from "../account/AccountSession"
import {
  AccountError,
  accountErrorMessage,
  authenticate,
  supportsPasskeys,
} from "../account/accountApi"
import { AppHeader } from "../components/AppHeader"
import { authenticationURL, loginDestination } from "../navigation"

export function AuthPage({
  mode,
  search,
}: {
  mode: "login" | "recover" | "setup" | "invite"
  search: string
}) {
  const session = useAccountSession()
  const [token, setToken] = useState("")
  const [name, setName] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [supported] = useState(supportsPasskeys)
  const request = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const next = loginDestination(search)
  const title =
    mode === "login"
      ? "Sign in"
      : mode === "setup"
        ? "Set up account"
        : mode === "invite"
          ? "Create account"
          : "Recover account"
  useEffect(() => {
    heading.current?.focus()
    return () => request.current?.abort()
  }, [])

  const submit = async () => {
    if (request.current || !supported) return
    const controller = new AbortController()
    request.current = controller
    const { signal } = controller
    const body =
      mode === "login"
        ? {}
        : {
            token,
            name: name.trim(),
            ...(mode === "invite" ? { display_name: displayName.trim() } : {}),
          }
    setToken("")
    setBusy(true)
    setError("")
    try {
      await authenticate(mode, body, undefined, signal)
      signal.throwIfAborted()
      session.setNotice(
        mode === "recover"
          ? "Account recovered. Review your API keys and revoke any compromised keys."
          : "Signed in.",
      )
      await session.refresh(signal)
    } catch (failure) {
      if (signal.aborted) return
      setError(accountErrorMessage(failure))
      if (failure instanceof AccountError && (failure.status === 403 || failure.status === 409)) {
        session.setNotice(accountErrorMessage(failure))
        try {
          await session.refresh(signal)
        } catch {
          /* Keep the original operation error. */
        }
      }
    } finally {
      if (!signal.aborted) {
        request.current = null
        setBusy(false)
      }
    }
  }

  return (
    <>
      <AppHeader />
      <main className="app-shell">
        <div className="account-page">
          <Heading as="h1" tabIndex={-1} ref={heading}>
            {title}
          </Heading>
          <Text as="p" role="status">
            {busy ? "Complete the passkey prompt, or cancel to stop." : session.notice}
          </Text>
          {error && (
            <Text as="p" role="alert">
              {error}
            </Text>
          )}
          {!supported && (
            <Text as="p" color="red">
              This browser does not support passkeys. Use a browser with WebAuthn support on HTTPS
              or localhost.
            </Text>
          )}
          <Card>
            {mode === "login" ? (
              <>
                <Button disabled={busy || !supported} onClick={() => void submit()}>
                  Sign in with passkey
                </Button>
                <Text as="p">
                  <a href={authenticationURL("recover", next)}>Recover account</a>
                </Text>
                <Text as="p">
                  <a href={authenticationURL("invite", next)}>Use an invitation</a>
                </Text>
              </>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void submit()
                }}
              >
                <Text as="p">
                  {mode === "setup"
                    ? "Use the one-time setup token from the operator command to register your first passkey."
                    : mode === "invite"
                      ? "Use the one-time invitation token from the operator to create a separate account."
                      : "Use a one-time operator recovery token. Recovery replaces all passkeys and signs out other sessions. Existing API keys stay active. Review and revoke keys after recovery if you suspect compromise."}
                </Text>
                <fieldset disabled={busy || !supported}>
                  <label htmlFor="auth-token">
                    {mode === "setup"
                      ? "Setup token"
                      : mode === "invite"
                        ? "Invitation token"
                        : "Recovery token"}
                  </label>
                  <input
                    id="auth-token"
                    type="password"
                    autoComplete="off"
                    required
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  {mode === "invite" && (
                    <>
                      <label htmlFor="auth-account-name">Account name</label>
                      <input
                        id="auth-account-name"
                        required
                        maxLength={200}
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                      />
                    </>
                  )}
                  <label htmlFor="auth-passkey-name">
                    {mode === "recover" ? "Replacement passkey name" : "Passkey name"}
                  </label>
                  <input
                    id="auth-passkey-name"
                    required
                    maxLength={100}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Button
                    type="submit"
                    disabled={
                      !token.trim() ||
                      !name.trim() ||
                      (mode === "invite" &&
                        (!displayName.trim() ||
                          new TextEncoder().encode(displayName.trim()).length > 200))
                    }
                  >
                    {title}
                  </Button>
                </fieldset>
                {(mode === "recover" || mode === "invite") && (
                  <Text as="p">
                    <a href={authenticationURL("login", next)}>Back to sign in</a>
                  </Text>
                )}
              </form>
            )}
          </Card>
        </div>
      </main>
    </>
  )
}
