import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import { test } from "vitest"

// Node10 module resolution reads the top-level types field, not exports.types.
test("package exposes built declarations to both legacy and modern TypeScript consumers", async () => {
  const packageUrl = new URL("../package.json", import.meta.url)
  const pkg = JSON.parse(await readFile(packageUrl, "utf8"))
  assert.equal(pkg.types, pkg.exports["."].types)
  await access(new URL(`../${pkg.types}`, import.meta.url))
})
