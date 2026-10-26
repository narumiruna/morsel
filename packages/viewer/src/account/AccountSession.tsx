import { Button, Text } from "@radix-ui/themes"
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { AppHeader } from "../components/AppHeader"
import { authenticationURL, loginDestination, navigate } from "../navigation"
import { LoadingPage } from "../pages/StatusPage"
import {
  type Account,
  AccountError,
  accountChannel,
  accountErrorMessage,
  accountRequest,
  broadcastAccountChange,
  type ExpectedAccount,
} from "./accountApi"

type Session = {
  account: Account
  expectedAccount: ExpectedAccount
  isAdminCurrent: () => boolean
  refresh: (signal: AbortSignal, destination?: string) => Promise<Account>
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
  onAccountChange,
}: {
  pathname: string
  search: string
  children: ReactNode
  onAccountChange?: () => void
}) {
  const [account, updateAccount] = useState<Account | null>(null)
  const current = useRef<Account | null>(null)
  const requestOrder = useRef(0)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [revision, setRevision] = useState(0)
  const [logout, setLogout] = useState(false)
  const setAccount = useCallback(
    (next: Account | null) => {
      const previous = current.current
      if (
        previous &&
        (!next ||
          previous.account_id !== next.account_id ||
          previous.authenticated !== next.authenticated)
      )
        onAccountChange?.()
      current.current = next
      updateAccount(next)
    },
    [onAccountChange],
  )
  const refresh = useCallback(
    async (signal: AbortSignal, destination?: string) => {
      const order = ++requestOrder.current
      let next: Account
      try {
        next = await accountRequest<Account>("account", { signal })
      } catch (failure) {
        if (signal.aborted || order !== requestOrder.current)
          throw new DOMException("Identity refresh superseded", "AbortError")
        throw failure
      }
      signal.throwIfAborted()
      if (order !== requestOrder.current)
        throw new DOMException("Identity refresh superseded", "AbortError")
      setAccount(next)
      // Complete navigation before an identity-keyed child can unmount.
      if (destination && next.authenticated)
        navigate(loginDestination(`?next=${encodeURIComponent(destination)}`), {
          replace: true,
          force: true,
        })
      return next
    },
    [setAccount],
  )
  const expire = useCallback(() => {
    ++requestOrder.current
    setNotice("Your session expired. Sign in again.")
    setAccount({ authenticated: false, setup_required: false })
  }, [setAccount])
  const signedOut = useCallback(() => {
    ++requestOrder.current
    broadcastAccountChange()
    setNotice("Signed out.")
    setLogout(true)
    setAccount({ authenticated: false, setup_required: false })
  }, [setAccount])
  const invalidate = useCallback(() => {
    ++requestOrder.current
    // Clear the identity synchronously, before any pending private response can be used.
    setAccount(null)
    setNotice("")
    setRevision((value) => value + 1)
  }, [setAccount])
  const isAdminCurrent = useCallback(
    () => current.current?.authenticated === true && current.current.role === "admin",
    [],
  )
  const id = account?.account_id ?? ""
  const expectedAccount = useMemo<ExpectedAccount>(
    () => ({
      id,
      isCurrent: () => !!id && current.current?.account_id === id,
      invalidate,
    }),
    [id, invalidate],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries or invalidates the account request.
  useEffect(() => {
    const controller = new AbortController()
    setError("")
    void refresh(controller.signal).catch((failure: unknown) => {
      if (
        controller.signal.aborted ||
        (failure instanceof DOMException && failure.name === "AbortError")
      )
        return
      if (failure instanceof AccountError && failure.status === 401) expire()
      else {
        setAccount(null)
        setError(accountErrorMessage(failure))
      }
    })
    return () => controller.abort()
  }, [refresh, expire, setAccount, revision])

  useEffect(() => {
    let controller: AbortController | undefined
    const recheck = () => {
      controller?.abort()
      controller = new AbortController()
      const { signal } = controller
      void refresh(signal).catch((failure: unknown) => {
        if (signal.aborted || (failure instanceof DOMException && failure.name === "AbortError"))
          return
        if (failure instanceof AccountError && failure.status === 401) expire()
        else {
          setAccount(null)
          setError(accountErrorMessage(failure))
        }
      })
    }
    const visible = () => {
      if (document.visibilityState === "visible") recheck()
    }
    const channel =
      typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(accountChannel)
    if (channel)
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "invalidate") invalidate()
      }
    const broadcast = () => channel?.postMessage("invalidate")
    window.addEventListener(accountChannel, broadcast)
    window.addEventListener("focus", recheck)
    document.addEventListener("visibilitychange", visible)
    return () => {
      controller?.abort()
      window.removeEventListener(accountChannel, broadcast)
      channel?.close()
      window.removeEventListener("focus", recheck)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [refresh, expire, invalidate, setAccount])

  const authRoute = ["/login", "/recover", "/setup", "/invite"].includes(pathname)
  const destination = authRoute ? loginDestination(search) : pathname
  let redirect: string | null = null
  if (account) {
    if (logout) redirect = "/login"
    else if (account.setup_required && pathname !== "/setup")
      redirect = authenticationURL("setup", destination)
    else if (
      !account.setup_required &&
      account.authenticated &&
      authRoute &&
      pathname !== "/invite"
    )
      redirect = destination
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
      value={{
        account,
        expectedAccount,
        isAdminCurrent,
        refresh,
        expire,
        signedOut,
        notice,
        setNotice,
      }}
    >
      {/* A changed session must not retain private state, dialogs, links, or pending actions. */}
      <Fragment key={id}>{children}</Fragment>
    </Context.Provider>
  )
}
