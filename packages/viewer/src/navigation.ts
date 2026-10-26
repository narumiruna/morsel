import { useEffect, useState } from "react"
import { parseRoute } from "./route"

const beforeNavigate = "morsel:before-navigate"
const navigationEvent = "morsel:navigate"

export function navigate(path: string, options: { replace?: boolean; force?: boolean } = {}) {
  const url = new URL(path, window.location.origin)
  // Programmatic navigation must never broadcast an invitation secret.
  if (url.pathname === "/invite") url.hash = ""
  window.dispatchEvent(new CustomEvent(navigationEvent, { detail: { path: url.href, ...options } }))
}

export function loginDestination(search: string): string {
  const values = new URLSearchParams(search).getAll("next")
  return values.length === 1 &&
    values[0] !== undefined &&
    ["/manage/shares", "/manage/api-keys", "/manage/invitations", "/account"].includes(values[0])
    ? values[0]
    : "/manage/shares"
}

export function authenticationURL(mode: "login" | "recover" | "setup" | "invite", next: string) {
  const destination = loginDestination(`?next=${encodeURIComponent(next)}`)
  return `/${mode}?next=${encodeURIComponent(destination)}`
}

function isDocumentAnchor(url: URL, current: URL) {
  if (
    url.pathname !== current.pathname ||
    url.search !== current.search ||
    (!url.hash && !url.href.endsWith("#")) ||
    url.hash.startsWith("#/")
  )
    return false
  // The Gist viewer uses a validated ID in the fragment as its route.
  return url.pathname !== "/gist/" || parseRoute(url.pathname, url.hash).kind !== "gist"
}

function canNavigate() {
  return window.dispatchEvent(new Event(beforeNavigate, { cancelable: true }))
}

// Keep routing local. No capability or login destination is stored outside the URL.
export function useAppLocation(
  captureInvitation: (arrival?: boolean) => number,
  clearInvitation: () => void,
) {
  const [location, setLocation] = useState(() => {
    const invitationRevision = captureInvitation()
    return {
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      invitationRevision,
    }
  })
  useEffect(() => {
    captureInvitation()
    let currentURL = window.location.href
    let index = Number.isSafeInteger(window.history.state?.morselIndex)
      ? window.history.state.morselIndex
      : 0
    let restoring = false
    window.history.replaceState({ ...window.history.state, morselIndex: index }, "")
    const update = (captured = false) => {
      const invitationRevision = captureInvitation(!captured)
      currentURL = window.location.href
      setLocation({
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
        invitationRevision,
      })
    }
    const pop = (event: Event) => {
      if (restoring) {
        restoring = false
        return
      }
      const hadInvitationFragment = window.location.pathname === "/invite" && !!window.location.hash
      if (
        window.location.href === currentURL &&
        !hadInvitationFragment &&
        (window.location.pathname !== "/invite" || event.type === "hashchange")
      )
        return
      captureInvitation(true)
      const nextIndex = window.history.state?.morselIndex
      const anchor =
        !hadInvitationFragment &&
        isDocumentAnchor(new URL(window.location.href), new URL(currentURL))
      if (!anchor && !canNavigate()) {
        clearInvitation()
        if (typeof nextIndex === "number" && nextIndex !== index) {
          restoring = true
          window.history.go(index - nextIndex)
        } else {
          window.history.replaceState({ morselIndex: index }, "", currentURL)
        }
        captureInvitation()
        return
      }
      index = typeof nextIndex === "number" ? nextIndex : index + 1
      window.history.replaceState({ ...window.history.state, morselIndex: index }, "")
      if (anchor) currentURL = window.location.href
      else update(true)
    }
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      const link = event.target instanceof Element ? event.target.closest("a") : null
      if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return
      const url = new URL(link.href)
      if (url.origin !== window.location.origin) return
      const current = new URL(currentURL)
      if (url.pathname !== "/invite" && isDocumentAnchor(url, current)) {
        const route = parseRoute(current.pathname, current.hash)
        if (
          route.kind === "gist" ||
          (route.kind === "share" && !current.pathname.startsWith("/s/"))
        ) {
          // Routing fragments contain capabilities or Gist IDs. Scroll within
          // the document without replacing them with a document anchor.
          event.preventDefault()
          let id = url.hash.slice(1)
          try {
            id = decodeURIComponent(id)
          } catch {
            // An invalid escape can still be a literal authored ID.
          }
          const target = id ? document.getElementById(id) : null
          if (target) target.scrollIntoView()
          else if (!id || id.toLowerCase() === "top") window.scrollTo({ top: 0 })
        }
        return
      }
      if (parseRoute(url.pathname, url.hash).kind === "not-found") return
      if (url.href === currentURL) {
        event.preventDefault()
        return
      }
      if (!canNavigate()) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      index += 1
      window.history.pushState({ morselIndex: index }, "", url)
      update()
    }
    const navigateTo = (event: Event) => {
      const { path, replace, force } = (
        event as CustomEvent<{
          path: string
          replace?: boolean
          force?: boolean
        }>
      ).detail
      const url = new URL(path, window.location.origin)
      if (url.origin !== window.location.origin || (!force && !canNavigate())) return
      if (replace) window.history.replaceState({ morselIndex: index }, "", url)
      else {
        index += 1
        window.history.pushState({ morselIndex: index }, "", url)
      }
      update()
    }
    const hash = (event: HashChangeEvent) => {
      if (!restoring) pop(event)
    }
    window.addEventListener(navigationEvent, navigateTo)
    document.addEventListener("click", click)
    window.addEventListener("popstate", pop)
    window.addEventListener("hashchange", hash)
    return () => {
      window.removeEventListener(navigationEvent, navigateTo)
      document.removeEventListener("click", click)
      window.removeEventListener("popstate", pop)
      window.removeEventListener("hashchange", hash)
    }
  }, [captureInvitation, clearInvitation])
  return location
}

export function useKeyDiscardWarning(rawKey: string | null) {
  useSecretDiscardWarning(
    !!rawKey,
    "Discard this API key? It is shown only once. Copy it before leaving.",
  )
}

export function useInvitationDiscardWarning(present: boolean) {
  useSecretDiscardWarning(
    present,
    "Discard this invitation link? It is shown only once. Copy it before leaving.",
  )
}

function useSecretDiscardWarning(present: boolean, message: string) {
  useEffect(() => {
    if (!present) return
    const warn = (event: Event) => {
      if (!window.confirm(message)) {
        event.preventDefault()
      }
    }
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener(beforeNavigate, warn)
    window.addEventListener("beforeunload", unload)
    return () => {
      window.removeEventListener(beforeNavigate, warn)
      window.removeEventListener("beforeunload", unload)
    }
  }, [present, message])
}
