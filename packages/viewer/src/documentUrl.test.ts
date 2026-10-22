import { describe, expect, it } from "vitest"
import { parseDocumentUrl } from "./documentUrl"

const origin = "https://morsel.example"
const token = `Ab_-${"0".repeat(39)}`
const gist = "7dbaf8170c7292354678069a9acb061f"

describe("parseDocumentUrl", () => {
  it.each([
    [`/s/${token}`, `/s/${token}`],
    [`s/${token}`, `/s/${token}`],
    [`${origin}/s/${token}`, `/s/${token}`],
    [`/#/s/${token}`, `/#/s/${token}`],
    [`#/s/${token}`, `/#/s/${token}`],
    [`${origin}/#/s/${token}`, `/#/s/${token}`],
    [`/gist/#${gist}`, `/gist/#${gist}`],
    [`gist/#${gist}`, `/gist/#${gist}`],
    [`${origin}/gist/#${gist}`, `/gist/#${gist}`],
    [`https://gist.github.com/${gist}`, `/gist/#${gist}`],
    [`https://gist.github.com/octo-cat/${gist}`, `/gist/#${gist}`],
    ["https://gist.github.com/A/ABCDEF", "/gist/#ABCDEF"],
    ["https://gist.github.com/0", "/gist/#0"],
    [`https://gist.github.com/${"f".repeat(64)}`, `/gist/#${"f".repeat(64)}`],
    [`HTTPS://GIST.GITHUB.COM/${gist}`, `/gist/#${gist}`],
    [`HTTPS://MORSEL.EXAMPLE/s/${token}`, `/s/${token}`],
    [`  ${origin}/#/s/${token}  `, `/#/s/${token}`],
  ])("accepts %s", (input, expected) => {
    expect(parseDocumentUrl(input, origin)).toBe(expected)
  })

  it.each([
    "",
    " ",
    "/",
    "#",
    "/example",
    "/account",
    `//morsel.example/s/${token}`,
    `//gist.github.com/${gist}`,
    `morsel.example/s/${token}`,
    `gist.github.com/${gist}`,
    `./s/${token}`,
    `../s/${token}`,
    `${origin}/other/../s/${token}`,
    `https:morsel.example/s/${token}`,
    `https:///morsel.example/s/${token}`,
    `http://morsel.example/s/${token}`,
    `javascript:alert(1)`,
    `data:text/plain,/s/${token}`,
    `ftp://morsel.example/s/${token}`,
    `http://gist.github.com/${gist}`,
    `https://gist.github.com.evil.test/${gist}`,
    `https://gist-github.com/${gist}`,
    `https://www.gist.github.com/${gist}`,
    `https://gist.github.com./${gist}`,
    `https://gıst.github.com/${gist}`,
    `https://other.example/s/${token}`,
    `https://morsel.example.evil.test/s/${token}`,
    `https://user@morsel.example/s/${token}`,
    `https://user:password@morsel.example/s/${token}`,
    `https://user@gist.github.com/${gist}`,
    `https://gist.github.com@evil.test/${gist}`,
    `https://morsel.example:444/s/${token}`,
    `https://morsel.example:443/s/${token}`,
    `https://gist.github.com:443/${gist}`,
    `https://gist.github.com:8443/${gist}`,
    "/s/short",
    `/s/${"A".repeat(42)}`,
    `/s/${"A".repeat(44)}`,
    `/s/${"A".repeat(42)}!`,
    `/s/${token}=`,
    `/s/${token}/`,
    `/s/${token}/extra`,
    `/s/${token}?q=1`,
    `/s/${token}?`,
    `/s/${token}#`,
    `/s/${token}#other`,
    `/#/s/${token}/extra`,
    `/#/s/${token}?q=1`,
    `/?q=1#/s/${token}`,
    `/#/s/${token}#extra`,
    `/index.html#/s/${token}`,
    "/gist/#",
    "/gist/#not-hex",
    `/gist/#${"a".repeat(65)}`,
    `/gist/${gist}`,
    `/gist/?q=1#${gist}`,
    `/gist/#${gist}/extra`,
    `/gist/#${gist}?q=1`,
    `/gist/#${gist}#extra`,
    `https://gist.github.com/${gist}/`,
    `https://gist.github.com/${gist}?q=1`,
    `https://gist.github.com/${gist}#file-readme-md`,
    `https://gist.github.com/owner/${gist}/raw`,
    `https://gist.github.com/-owner/${gist}`,
    `https://gist.github.com/owner-/${gist}`,
    `https://gist.github.com/owner--name/${gist}`,
    `https://gist.github.com/${"a".repeat(40)}/${gist}`,
    `https://gist.github.com/owner/not-hex`,
    `https://gist.github.com/a/../${gist}`,
    `https://gist.github.com/%6fwner/${gist}`,
    `https://gist.github.com%2fevil.test/${gist}`,
    `/s/%41${"A".repeat(42)}`,
    `/s/${token}%2fextra`,
    `/s/${token}\nmore`,
    `/s/\t${token}`,
    `/s/\u0000${token}`,
    String.raw`https:\\morsel.example\s\${token}`,
  ])("rejects %s", (input) => {
    expect(parseDocumentUrl(input, origin)).toBeNull()
  })

  it("accepts only the current local development origin and port", () => {
    const local = "http://localhost:12647"
    expect(parseDocumentUrl(`${local}/#/s/${token}`, local)).toBe(`/#/s/${token}`)
    expect(parseDocumentUrl(`http://localhost/s/${token}`, local)).toBeNull()
    expect(parseDocumentUrl(`http://localhost:12648/s/${token}`, local)).toBeNull()
    expect(parseDocumentUrl(`https://localhost:12647/s/${token}`, local)).toBeNull()
  })

  it("fails closed with an invalid or unsafe application origin", () => {
    expect(parseDocumentUrl(`/s/${token}`, "not a URL")).toBeNull()
    expect(parseDocumentUrl(`/s/${token}`, "file:///")).toBeNull()
  })
})
