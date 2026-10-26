export type Route =
  | { kind: "home" }
  | { kind: "authentication"; mode: "login" | "recover" | "setup" | "invite" }
  | { kind: "account" }
  | { kind: "management"; section: "shares" | "api-keys" }
  | { kind: "example" }
  | { kind: "share"; token: string }
  | { kind: "gist"; id: string }
  | { kind: "invalid-share" }
  | { kind: "invalid-gist" }
  | { kind: "not-found" }

const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const gistPattern = /^[0-9A-Fa-f]{1,64}$/

export function parseRoute(pathname: string, hash: string): Route {
  if (["/login", "/recover", "/setup", "/invite"].includes(pathname))
    return {
      kind: "authentication",
      mode: pathname.slice(1) as "login" | "recover" | "setup" | "invite",
    }
  if (pathname === "/account") return { kind: "account" }
  if (pathname === "/manage/shares") return { kind: "management", section: "shares" }
  if (pathname === "/manage/api-keys") return { kind: "management", section: "api-keys" }
  if (pathname === "/example") return { kind: "example" }
  if (pathname.startsWith("/s/")) {
    const token = pathname.slice(3)
    if (!tokenPattern.test(token)) return { kind: "invalid-share" }
    return { kind: "share", token }
  }
  if (pathname === "/gist/") {
    const id = hash.slice(1)
    if (!gistPattern.test(id)) return { kind: "invalid-gist" }
    return { kind: "gist", id }
  }
  if (pathname.startsWith("/gist/")) return { kind: "invalid-gist" }
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
