import { Button, Card, Flex, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { formatDate } from "../formatDate"
import { useInvitationDiscardWarning } from "../navigation"
import { useAccountSession } from "./AccountSession"
import {
  AccountError,
  accountErrorMessage,
  accountRequest,
  authenticate,
  checkAccount,
  supportsPasskeys,
} from "./accountApi"

type Invitation = { invitation_url: string; expires_at: string }

// One-time links and pending work belong only to this mounted admin section.
export function InvitationManagement({ sessionSignal }: { sessionSignal: AbortSignal }) {
  const { expectedAccount, isAdminCurrent, refresh, expire } = useAccountSession()
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [expired, setExpired] = useState(false)
  const request = useRef<AbortController | null>(null)
  const epoch = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  useInvitationDiscardWarning(!!invitation)

  useEffect(() => {
    const cancel = () => {
      ++epoch.current
      request.current?.abort()
      setInvitation(null)
    }
    sessionSignal.addEventListener("abort", cancel, { once: true })
    return () => {
      sessionSignal.removeEventListener("abort", cancel)
      ++epoch.current
      request.current?.abort()
    }
  }, [sessionSignal])

  useEffect(() => {
    if (!invitation) return
    input.current?.focus()
    input.current?.select()
    const remaining = Date.parse(invitation.expires_at) - Date.now()
    setExpired(remaining <= 0)
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining))
    return () => window.clearTimeout(timer)
  }, [invitation])

  const dismiss = () => {
    ++epoch.current
    request.current?.abort()
    request.current = null
    setBusy(false)
    setInvitation(null)
    setError("")
    setNotice("")
    setExpired(false)
  }

  const run = async (copy: boolean) => {
    if (
      sessionSignal.aborted ||
      request.current ||
      (!copy && invitation) ||
      (copy && (!invitation || expired))
    )
      return
    const controller = new AbortController()
    request.current = controller
    const turn = ++epoch.current
    const { signal } = controller
    const check = () => {
      sessionSignal.throwIfAborted()
      signal.throwIfAborted()
      if (turn !== epoch.current) throw new DOMException("Superseded", "AbortError")
      checkAccount(expectedAccount)
      if (!isAdminCurrent()) throw new DOMException("Permission changed", "AbortError")
    }
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const current = await refresh(signal)
      check()
      const csrf = current.csrf_token
      if (!current.authenticated || !csrf)
        throw new AccountError(401, "session_expired", "Your session expired.")
      if (current.role !== "admin") {
        dismiss()
        return
      }
      if (copy) {
        if (!invitation || Date.parse(invitation.expires_at) <= Date.now()) {
          setExpired(true)
          return
        }
        // Check again immediately before the irreversible clipboard call.
        check()
        try {
          await navigator.clipboard.writeText(invitation.invitation_url)
        } catch {
          check()
          setError("Could not copy link. Select and copy the invitation link manually.")
          input.current?.focus()
          input.current?.select()
          return
        }
        check()
        setNotice("Invitation link copied.")
      } else {
        if (current.verification_required !== false) {
          setNotice("Verify your passkey to continue. Complete the prompt, or cancel to stop.")
          await authenticate("verify", {}, csrf, signal, expectedAccount)
          check()
        }
        const result = await accountRequest<Invitation>("account/invitations", {
          method: "POST",
          body: {},
          csrf,
          signal,
          expectedAccount,
        })
        check()
        setInvitation(result)
        setNotice("")
      }
    } catch (failure) {
      // Old failures must not refresh or revive an obsolete identity.
      if (
        signal.aborted ||
        sessionSignal.aborted ||
        turn !== epoch.current ||
        !expectedAccount.isCurrent() ||
        !isAdminCurrent()
      )
        return
      if (failure instanceof AccountError && failure.status === 401) expire()
      else {
        setError(accountErrorMessage(failure))
        setNotice("")
        if (failure instanceof AccountError && [403, 409].includes(failure.status)) {
          try {
            await refresh(signal)
            check()
          } catch {
            // The session boundary owns refresh failures. Never replay a mutation.
          }
        }
      }
    } finally {
      if (turn === epoch.current) {
        request.current = null
        if (!signal.aborted) setBusy(false)
      }
    }
  }

  return (
    <Card>
      <Text as="p">
        Create a one-use link for a new user account. It expires after one hour. Anyone with the
        unused link can register. Send it through a secure messaging channel.
      </Text>
      {error && (
        <Text as="p" role="alert">
          {error}
        </Text>
      )}
      <Text as="p" role="status">
        {busy ? notice || "Checking account…" : notice}
      </Text>
      {invitation ? (
        <>
          <Text as="p">This link is shown only once. Copy it before dismissal or leaving.</Text>
          <Text as="p">Expires {formatDate(invitation.expires_at)}</Text>
          {expired && (
            <Text as="p" role="alert">
              This invitation link has expired. Dismiss it to create another.
            </Text>
          )}
          <label htmlFor="invitation-link">Invitation link</label>
          <input
            id="invitation-link"
            ref={input}
            readOnly
            value={invitation.invitation_url}
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Flex gap="3" wrap="wrap">
            <Button disabled={busy || expired} onClick={() => void run(true)}>
              Copy link
            </Button>
            <Button variant="soft" onClick={dismiss}>
              Dismiss invitation link
            </Button>
          </Flex>
        </>
      ) : (
        <Button disabled={busy || !supportsPasskeys()} onClick={() => void run(false)}>
          Create invitation link
        </Button>
      )}
    </Card>
  )
}
