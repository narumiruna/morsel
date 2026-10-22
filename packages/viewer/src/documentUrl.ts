const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const gistPattern = /^[0-9A-Fa-f]{1,64}$/
const ownerPattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/

// Inspect the original spelling: URL normalization can hide dot segments,
// credentials, explicit default ports, and encoded route separators.
export function parseDocumentUrl(input: string, origin: string): string | null {
  const value = input.trim()
  if (!value || /[\s\\%]/u.test(value)) return null

  let base: URL
  try {
    base = new URL(origin)
  } catch {
    return null
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null

  let path = value
  const absolute = /^(https?):\/\/([^/?#]+)(\/.*)?$/i.exec(value)
  if (absolute) {
    const [, scheme = "", authority = "", suffix = ""] = absolute
    const addressOrigin = `${scheme.toLowerCase()}://${authority.toLowerCase()}`
    if (addressOrigin === base.origin.toLowerCase()) {
      path = suffix
    } else if (addressOrigin === "https://gist.github.com") {
      const parts = /^\/([^/?#]+)(?:\/([^/?#]+))?$/.exec(suffix)
      if (!parts) return null
      const [, first = "", second] = parts
      if (second === undefined) return gistPattern.test(first) ? `/gist/#${first}` : null
      if (first.length > 39 || !ownerPattern.test(first) || !gistPattern.test(second)) return null
      return `/gist/#${second}`
    } else {
      return null
    }
  }

  const share = /^\/?s\/([^/?#]+)$/.exec(path)
  if (share?.[1] && tokenPattern.test(share[1])) return `/s/${share[1]}`

  const fragmentShare = /^(?:\/)?#\/s\/([^/?#]+)$/.exec(path)
  if (fragmentShare?.[1] && tokenPattern.test(fragmentShare[1])) return `/#/s/${fragmentShare[1]}`

  const gist = /^\/?gist\/#([^/?#]+)$/.exec(path)
  if (gist?.[1] && gistPattern.test(gist[1])) return `/gist/#${gist[1]}`
  return null
}
