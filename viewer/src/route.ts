export type Route =
  | { kind: "home" }
  | { kind: "share"; token: string }
  | { kind: "invalid-share" }
  | { kind: "not-found" }

const tokenPattern = /^[A-Za-z0-9_-]{43}$/

export function parseHash(hash: string): Route {
  if (hash === "" || hash === "#" || hash === "#/") return { kind: "home" }
  if (hash.startsWith("#/s/")) {
    const token = hash.slice(4)
    if (!tokenPattern.test(token)) return { kind: "invalid-share" }
    return { kind: "share", token }
  }
  return { kind: "not-found" }
}
