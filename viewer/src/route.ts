export type Route =
  | { kind: "home" }
  | { kind: "share"; token: string }
  | { kind: "invalid-share" }
  | { kind: "not-found" }

const tokenPattern = /^[A-Za-z0-9_-]{43}$/

export function parseRoute(pathname: string, hash: string): Route {
  if (pathname.startsWith("/s/")) {
    const token = pathname.slice(3)
    if (!tokenPattern.test(token)) return { kind: "invalid-share" }
    return { kind: "share", token }
  }
  if (pathname !== "/" && pathname !== "/index.html") return { kind: "not-found" }
  return parseHash(hash)
}

export function parseHash(hash: string): Route {
  if (hash === "" || hash === "#" || hash === "#/") return { kind: "home" }
  if (hash.startsWith("#/s/")) {
    const token = hash.slice(4)
    if (!tokenPattern.test(token)) return { kind: "invalid-share" }
    return { kind: "share", token }
  }
  return { kind: "not-found" }
}
