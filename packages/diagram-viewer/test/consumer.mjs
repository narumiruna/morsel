import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"
import { previewURL } from "./preview.mjs"

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directory = await mkdtemp(join(tmpdir(), "diagram-consumer-"))
let browser
let server

function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 })
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

try {
  const [packed] = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], workspace),
  )
  const files = packed.files.map((entry) => entry.path)
  for (const path of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/core/index.js",
    "dist/core/index.d.ts",
    "dist/styles.css",
    "README.md",
    "LICENSE",
  ])
    assert.ok(files.includes(path), `Missing ${path}`)
  assert.ok(files.every((path) => !path.includes(".test.") && !path.startsWith("src/")))
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  )
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=peer",
    join(directory, packed.filename),
  ])
  await writeFile(
    join(directory, "core.mjs"),
    `
import assert from "node:assert/strict"
import { registerHooks } from "node:module"
for (const name of ["window", "document", "navigator"]) Object.defineProperty(globalThis, name, { get() { throw new Error("Import accessed " + name) }, configurable: true })
registerHooks({ resolve(specifier, context, next) {
  if (/^(react|react-dom|@radix-ui|mermaid|vega)(\\/|$)/.test(specifier)) throw new Error("Core imported " + specifier)
  return next(specifier, context)
} })
const core = await import("@narumitw/diagram-viewer/core")
assert.equal(typeof core.createDiagramController, "function")
assert.equal(core.getDiagramAction(core.initialDiagramState, {source:""}, "zoomIn").disabled, false)
console.log("Core imports without browser globals, React, or renderers")
`,
  )
  run(process.execPath, ["core.mjs"])

  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "react@19.3.1",
    "react-dom@19.3.1",
    "@types/react@19.3.0",
    "@types/react-dom@19.3.0",
    "typescript@7.0.2",
    "vite@8.3.8",
  ])
  await writeFile(
    join(directory, "examples.tsx"),
    await readFile(join(workspace, "test/examples.tsx"), "utf8"),
  )
  run(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--module",
    "NodeNext",
    "--target",
    "ES2022",
    "--jsx",
    "react-jsx",
    "examples.tsx",
  ])
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Packed diagram consumer</title></head><body><main id="root"></main><script type="module" src="/main.tsx"></script></body></html>',
  )
  await writeFile(
    join(directory, "main.tsx"),
    `import React from "react"; import {createRoot} from "react-dom/client"; import {DefaultExample, ComposedExample, HostMountExample} from "./examples"; createRoot(document.getElementById("root")!).render(<><DefaultExample/><ComposedExample/><HostMountExample/></>);`,
  )
  // The examples use the automatic JSX transform, without a React namespace import.
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
  )
  run(process.execPath, ["node_modules/vite/bin/vite.js", "build"])
  let output = ""
  server = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "0"],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  )
  server.stdout.on("data", (chunk) => {
    output += chunk
  })
  server.stderr.on("data", (chunk) => {
    output += chunk
  })
  let baseURL
  for (let attempts = 0; attempts < 100; attempts++) {
    baseURL = previewURL(output)
    if (baseURL) break
    if (server.exitCode !== null) throw new Error(output)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(baseURL, output)
  const wsl =
    process.env.WSL_DISTRO_NAME ||
    process.env.WSL_INTEROP ||
    /microsoft/i.test(await readFile("/proc/sys/kernel/osrelease", "utf8").catch(() => ""))
  browser = await chromium.launch({ args: wsl ? ["--ozone-platform=wayland"] : [] })
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(baseURL)
  const viewer = page.locator(".ndv-root").first()
  await viewer.getByRole("button", { name: "Zoom in" }).click()
  await page.waitForFunction(() => document.querySelector("output")?.textContent === "125%")
  assert.equal(await viewer.getByLabel("Current zoom").textContent(), "125%")
  assert.equal(
    await viewer
      .getByRole("button", { name: "Zoom in" })
      .evaluate((element) => getComputedStyle(element).minHeight),
    "44px",
  )
  const host = page.locator(".ndv-root").nth(2)
  await host.locator(".ndv-stage svg").waitFor()
  await host.getByRole("button", { name: "Show source" }).click()
  await host.getByRole("button", { name: "Show diagram" }).click()
  assert.equal(await host.locator(".ndv-stage svg").count(), 1)
  assert.deepEqual(errors, [])
  console.log(
    "Packed consumer: core import, inventory, declarations, examples, Vite build, CSS, and Chromium interactions passed",
  )
} finally {
  await browser?.close()
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve))
    server.kill("SIGTERM")
    await exited
  }
  await rm(directory, { recursive: true, force: true })
}
