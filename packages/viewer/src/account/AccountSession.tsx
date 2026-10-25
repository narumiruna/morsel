import { Button, Text } from "@radix-ui/themes"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react"
import { AppHeader } from "../components/AppHeader"
import { authenticationURL, loginDestination, navigate } from "../navigation"
import { LoadingPage } from "../pages/StatusPage"
import { type Account, AccountError, accountErrorMessage, accountRequest } from "./accountApi"

type Session = {
  account: Account
  refresh: (signal: AbortSignal) => Promise<Account>
  setAccount: (account: Account) => void
  expire: () => void
  signedOut: () => void
  notice: string
  setNotice: (notice: string) => void
}
const Context = createContext<Session | null>(null)

export function useAccountSession() {
  const session = useContext(Context)
  if (!session) throw new Error("Account session boundary is required")
  return session
}

export function AccountSession({
  pathname,
  search,
  children,
}: {
  pathname: string
  search: string
  children: ReactNode
}) {
  const [account, setAccount] = useState<Account | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [revision, setRevision] = useState(0)
  const [logout, setLogout] = useState(false)
  const refresh = useCallback(async (signal: AbortSignal) => {
    const next = await accountRequest<Account>("account", { signal })
    signal.throwIfAborted()
    setAccount(next)
    return next
  }, [])
  const expire = useCallback(() => {
    setNotice("Your session expired. Sign in again.")
    setAccount({ authenticated: false, setup_required: false })
  }, [])
  const signedOut = useCallback(() => {
    setNotice("Signed out.")
    setLogout(true)
    setAccount({ authenticated: false, setup_required: false })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries the initial account request.
  useEffect(() => {
    const controller = new AbortController()
    setError("")
    void refresh(controller.signal).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      if (failure instanceof AccountError && failure.status === 401) expire()
      else setError(accountErrorMessage(failure))
    })
    return () => controller.abort()
  }, [refresh, expire, revision])

  const authRoute = ["/login", "/recover", "/setup"].includes(pathname)
  const destination = authRoute ? loginDestination(search) : pathname
  let redirect: string | null = null
  if (account) {
    if (logout) redirect = "/login"
    else if (account.setup_required && pathname !== "/setup")
      redirect = authenticationURL("setup", destination)
    else if (!account.setup_required && account.authenticated && authRoute) redirect = destination
    else if (
      !account.setup_required &&
      !account.authenticated &&
      (!authRoute || pathname === "/setup")
    )
      redirect = authenticationURL("login", destination)
  }
  useEffect(() => {
    if (!redirect) return
    navigate(redirect, { replace: true, force: true })
    setLogout(false)
  }, [redirect])

  if (!account || redirect)
    return (
      <>
        <AppHeader />
        <main className="app-shell">
          {error ? (
            <>
              <Text as="p" role="alert">
                {error}
              </Text>
              <Button onClick={() => setRevision((value) => value + 1)}>Retry account</Button>
            </>
          ) : (
            <LoadingPage subject="account" />
          )}
        </main>
      </>
    )
  return (
    <Context.Provider
      value={{ account, refresh, setAccount, expire, signedOut, notice, setNotice }}
    >
      {children}
    </Context.Provider>
  )
}
