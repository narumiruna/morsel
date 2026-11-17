import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { runChangeset } from "./changeset.mjs"
import { publishDiagramViewer } from "./publish-diagram-viewer.mjs"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
const packageName = "@narumitw/diagram-viewer"
const packageDirectory = "packages/diagram-viewer"
const registry = "--registry=https://registry.npmjs.org"
const view = (version) => [
  "npm",
  "view",
  `${packageName}@${version}`,
  "version",
  "--json",
  registry,
]
const publish = [
  "npm",
  "publish",
  "--workspace",
  packageName,
  "--access",
  "public",
  "--provenance",
  registry,
]
const missingVersion = {
  status: 1,
  stdout: JSON.stringify({ error: { code: "E404", summary: "No match found for version" } }),
}

async function fixture(t, { version = "0.1.1", changelog = true, manifest = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "morsel-npm-release-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, ".changeset"))
  await copyFile(
    join(repositoryRoot, ".changeset/config.json"),
    join(root, ".changeset/config.json"),
  )
  const pkg = {
    name: "@narumitw/morsel",
    version: "0.3.1",
    private: true,
    workspaces: ["packages/*"],
  }
  // The real Changesets config ignores client/viewer, so discovery must include both.
  const packages = {
    "": pkg,
    [packageDirectory]: {
      name: packageName,
      version,
      publishConfig: { access: "public" },
      ...manifest,
    },
    "packages/client": { name: "@narumitw/morsel-client", version: "0.1.0" },
    "packages/viewer": {
      name: "@narumitw/morsel-viewer",
      version: "0.1.0",
      private: true,
      dependencies: { [packageName]: version },
    },
  }
  for (const [directory, entry] of Object.entries(packages)) {
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, directory, "package.json"), `${JSON.stringify(entry, null, 2)}\n`)
  }
  await writeFile(
    join(root, "package-lock.json"),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages }, null, 2)}\n`,
  )
  if (changelog) {
    await writeFile(
      join(root, packageDirectory, "CHANGELOG.md"),
      `# Diagram viewer\n\n## ${version}\n\nPackage release.\n`,
    )
  }
  return root
}

async function snapshot(root) {
  const files = {}
  const walk = async (directory) => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files[path] = await readFile(join(root, path), "utf8")
    }
  }
  await walk("")
  return files
}

async function publication(t, root, { response = missingVersion, publishFailure = false } = {}) {
  const bin = await mkdtemp(join(tmpdir(), "morsel-npm-release-commands-"))
  t.after(() => rm(bin, { recursive: true, force: true }))
  const log = join(bin, "commands.jsonl")
  await writeFile(log, "")
  const stub = [
    "#!/usr/bin/env node",
    'const { appendFileSync } = require("node:fs")',
    'const { basename } = require("node:path")',
    "const command = basename(process.argv[1])",
    "const args = process.argv.slice(2)",
    "const state = JSON.parse(process.env.NPM_RELEASE_TEST_STATE)",
    "appendFileSync(process.env.NPM_RELEASE_TEST_LOG, JSON.stringify({",
    '  command: [command, ...args], cwd: process.cwd(), }) + "\\n")',
    'if (command === "npm" && args[0] === "view") {',
    '  process.stdout.write(state.response.stdout ?? "")',
    '  process.stderr.write(state.response.stderr ?? "")',
    "  if (state.response.signal) process.kill(process.pid, state.response.signal)",
    "  process.exit(state.response.status ?? 0)",
    '} else if (command === "npm" && args[0] === "publish") {',
    '  if (state.publishFailure) { console.error("Publication failed"); process.exit(1) }',
    '} else { console.error("Unexpected release command", command, args); process.exit(90) }',
  ].join("\n")
  // Any accidental git/gh invocation fails instead of creating a real tag or release.
  for (const command of ["npm", "git", "gh"]) {
    await writeFile(join(bin, command), stub)
    await chmod(join(bin, command), 0o700)
  }
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    NPM_RELEASE_TEST_LOG: log,
    NPM_RELEASE_TEST_STATE: JSON.stringify({ response, publishFailure }),
  }
  const calls = async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return {
    env,
    run: () => publishDiagramViewer(root, env),
    calls: async () => (await calls()).map((call) => call.command),
    directories: async () => (await calls()).map((call) => call.cwd),
  }
}

async function changeset(root, targets) {
  await writeFile(
    join(root, ".changeset/pending.md"),
    `---\n${targets.map((name) => `"${name}": patch`).join("\n")}\n---\n\nPending release.\n`,
  )
}

test("already-public 0.1.0 is a no-op even without an initial changelog", async (t) => {
  const root = await fixture(t, { version: "0.1.0", changelog: false })
  const before = await snapshot(root)
  const command = await publication(t, root, { response: { stdout: '"0.1.0"\n' } })
  assert.equal(await command.run(), null)
  assert.equal(await command.run(), null)
  assert.deepEqual(await command.calls(), [view("0.1.0"), view("0.1.0")])
  assert.deepEqual(await snapshot(root), before)
})

test("structured E404 publishes only the exact public diagram workspace with provenance", async (t) => {
  const root = await fixture(t)
  const before = await snapshot(root)
  const command = await publication(t, root)
  assert.equal(await command.run(), "0.1.1")
  assert.deepEqual(await command.calls(), [view("0.1.1"), publish])
  assert.deepEqual(await command.directories(), [root, root])
  assert.deepEqual(await snapshot(root), before)
  const actual = JSON.parse(
    await readFile(join(repositoryRoot, packageDirectory, "package.json"), "utf8"),
  )
  assert.equal(actual.scripts.prepack, "npm run build")
  assert.ok(actual.files.includes("CHANGELOG.md"))
})

for (const targets of [[packageName], ["@narumitw/morsel", packageName]]) {
  test(`pending ${targets.join(" and ")} releases skip before registry access`, async (t) => {
    const root = await fixture(t, { changelog: false })
    await changeset(root, targets)
    const before = await snapshot(root)
    const plan = JSON.parse(await runChangeset(["status"], root))
    assert.ok(
      plan.releases.some((release) => release.name === packageName && release.type === "patch"),
    )
    assert.ok(
      plan.releases.some(
        (release) => release.name === "@narumitw/morsel-viewer" && release.type === "none",
      ),
    )
    const command = await publication(t, root)
    assert.equal(await command.run(), null)
    assert.deepEqual(await command.calls(), [])
    assert.deepEqual(await snapshot(root), before)
  })
}

for (const dependent of [false, true]) {
  test(`root-only pending changesets do not block publication${dependent ? " with a none diagram dependent" : ""}`, async (t) => {
    const root = await fixture(t, {
      manifest: dependent ? { devDependencies: { "@narumitw/morsel": "0.3.1" } } : {},
    })
    await changeset(root, ["@narumitw/morsel"])
    if (dependent) {
      const plan = JSON.parse(await runChangeset(["status"], root))
      assert.ok(
        plan.releases.some((release) => release.name === packageName && release.type === "none"),
      )
    }
    const before = await snapshot(root)
    const command = await publication(t, root)
    assert.equal(await command.run(), "0.1.1")
    assert.deepEqual(await command.calls(), [view("0.1.1"), publish])
    assert.deepEqual(await snapshot(root), before)
  })
}

for (const [label, manifest, message] of [
  ["wrong name", { name: "@narumitw/other" }, /must be named/],
  ["private package", { private: true }, /must not be private/],
  ["restricted access", { publishConfig: { access: "restricted" } }, /publishConfig.access/],
  ["missing access", { publishConfig: {} }, /publishConfig.access/],
  ["missing publishConfig", { publishConfig: null }, /publishConfig.access/],
  ...["0.1.1-beta.1", "0.1.1+build", "01.1.0", "v0.1.1", "0.1", 1, null].map((version) => [
    `unstable or invalid version ${version}`,
    { version },
    /stable semantic version/,
  ]),
]) {
  test(`${label} fails before any npm command`, async (t) => {
    const root = await fixture(t, { manifest })
    const command = await publication(t, root)
    await assert.rejects(command.run(), message)
    assert.deepEqual(await command.calls(), [])
  })
}

for (const [label, response] of [
  ["authentication", { status: 1, stdout: '{"error":{"code":"E401"}}' }],
  ["authorization", { status: 1, stdout: '{"error":{"code":"E403"}}' }],
  ["network", { status: 1, stdout: '{"error":{"code":"ENOTFOUND"}}' }],
  ["timeout", { status: 1, stderr: "ETIMEDOUT" }],
  ["signal despite structured E404 output", { ...missingVersion, signal: "SIGTERM" }],
  ["E404 text instead of JSON", { status: 1, stdout: "npm error code E404" }],
  ["E404 text on stderr", { status: 1, stderr: "npm error code E404" }],
  [
    "E404 text hiding an auth failure",
    { status: 1, stdout: '{"error":{"code":"E401","summary":"E404"}}' },
  ],
  ["invalid error JSON", { status: 1, stdout: '{"error":{"code":"E404"}' }],
  ["unstructured error JSON", { status: 1, stdout: '{"code":"E404"}' }],
  ["empty error object", { status: 1, stdout: "{}" }],
  ["null error", { status: 1, stdout: "null" }],
]) {
  test(`${label} fails closed without publishing`, async (t) => {
    const root = await fixture(t)
    const command = await publication(t, root, { response })
    await assert.rejects(command.run(), /Cannot determine the published/)
    assert.deepEqual(await command.calls(), [view("0.1.1")])
  })
}

for (const stdout of [
  "",
  "not JSON",
  '"0.1.0"',
  '["0.1.1"]',
  '{"version":"0.1.1"}',
  '{"error":{"code":"E404"}}',
  "null",
  "1",
]) {
  test(`malformed or mismatched successful registry response ${JSON.stringify(stdout)} fails closed`, async (t) => {
    const root = await fixture(t)
    const command = await publication(t, root, { response: { stdout } })
    await assert.rejects(command.run(), /registry/)
    assert.deepEqual(await command.calls(), [view("0.1.1")])
  })
}

for (const heading of [null, "# 0.1.1", "## 0.1.0", "## 0.1.10", "### 0.1.1"]) {
  test(`unpublished version requires its own changelog heading: ${heading}`, async (t) => {
    const root = await fixture(t, { changelog: false })
    if (heading) await writeFile(join(root, packageDirectory, "CHANGELOG.md"), `${heading}\n`)
    const command = await publication(t, root)
    await assert.rejects(command.run(), /CHANGELOG.md/)
    assert.deepEqual(await command.calls(), [view("0.1.1")])
  })
}

test("invalid changeset targets fail before registry access", async (t) => {
  const root = await fixture(t)
  await changeset(root, ["@narumitw/morsel-client"])
  const before = await snapshot(root)
  const command = await publication(t, root)
  await assert.rejects(command.run(), /must target only/)
  assert.deepEqual(await command.calls(), [])
  assert.deepEqual(await snapshot(root), before)
})

test("publish failure is propagated without changing versions or changesets", async (t) => {
  const root = await fixture(t)
  const before = await snapshot(root)
  const command = await publication(t, root, { publishFailure: true })
  await assert.rejects(command.run(), /Publication failed/)
  assert.deepEqual(await command.calls(), [view("0.1.1"), publish])
  assert.deepEqual(await snapshot(root), before)
})

test("npm job grants only package publication permissions within the release workflow", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
  assert.match(workflow, /^name: Publish$/m)
  await assert.rejects(readFile(join(repositoryRoot, ".github/workflows/npm-release.yml")), {
    code: "ENOENT",
  })
  assert.equal([...workflow.matchAll(/id-token: write/g)].length, 1)
  assert.match(workflow, /on:\n {2}workflow_dispatch:\n {2}push:\n {4}branches: \[main\]/)
  assert.match(workflow, /^permissions:\n {2}contents: read$/m)
  assert.match(
    workflow,
    /concurrency:\n {2}group: \$\{\{ github.workflow \}\}-\$\{\{ github.ref \}\}\n {2}cancel-in-progress: false/,
  )
  const npm = workflow.split("\n  npm-publish:\n")[1]?.split(/\n {2}[\w-]+:\n/)[0]
  assert.ok(npm, "Publish must retain an independent npm publication job")
  assert.match(npm, /^ {4}name: Publish diagram-viewer$/m)
  assert.match(npm, /if: github.ref == 'refs\/heads\/main'/)
  assert.match(npm, /runs-on: ubuntu-latest/)
  assert.match(npm, / {4}permissions:\n {6}contents: read\n {6}id-token: write/)
  assert.match(npm, /persist-credentials: false/)
  assert.match(npm, /node-version: 26/)
  assert.match(npm, /registry-url: https:\/\/registry.npmjs.org/)
  assert.match(npm, /package-manager-cache: false/)
  assert.equal([...npm.matchAll(/name: Verify latest main/g)].length, 1)
  const latestMain = [
    "      - name: Verify latest main",
    "        run: |",
    "          git fetch origin main",
    '          test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"',
  ].join("\n")
  assert.ok(npm.includes(latestMain))
  assert.ok(npm.indexOf(latestMain) > npm.indexOf("- run: npm ci"))
  assert.ok(npm.indexOf(latestMain) < npm.indexOf("- run: npm run release:diagram-viewer"))
  const jobs = workflow.split("\njobs:\n")[1]
  assert.deepEqual(
    [...jobs.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]),
    ["publish", "npm-publish", "container", "release", "deploy"],
  )
  assert.deepEqual(
    [...npm.matchAll(/- uses: (.+)/g)].map((match) => match[1]),
    ["actions/checkout@v7", "actions/setup-node@v7"],
  )
  assert.deepEqual(
    [...npm.matchAll(/- run: (.+)/g)].map((match) => match[1]),
    ["npm ci", "npm run release:diagram-viewer"],
  )
  assert.doesNotMatch(
    npm,
    /secrets:|secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN|contents: write|packages: write|pull-requests: write|workflow_call:|needs:/,
  )
})

for (const mode of ["published", "existing", "pending", "failure"]) {
  test(`CLI ${mode} writes published-version only after an actual successful publish`, async (t) => {
    const root = await fixture(t, { changelog: mode !== "existing" })
    if (mode === "pending") await changeset(root, [packageName])
    await mkdir(join(root, "scripts"))
    for (const script of ["publish-diagram-viewer.mjs", "changeset.mjs"]) {
      await copyFile(join(repositoryRoot, "scripts", script), join(root, "scripts", script))
    }
    await symlink(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "dir")
    const output = join(root, "github-output")
    await writeFile(output, "sentinel=untouched\n")
    const command = await publication(t, root, {
      response: mode === "existing" ? { stdout: '"0.1.1"' } : missingVersion,
      publishFailure: mode === "failure",
    })
    const result = spawnSync(process.execPath, [join(root, "scripts/publish-diagram-viewer.mjs")], {
      cwd: join(root, packageDirectory),
      env: { ...command.env, GITHUB_OUTPUT: output },
      encoding: "utf8",
    })
    assert.equal(result.status, mode === "failure" ? 1 : 0, result.stderr)
    assert.equal(
      await readFile(output, "utf8"),
      `sentinel=untouched\n${mode === "published" ? "published-version=0.1.1\n" : ""}`,
    )
    assert.deepEqual(
      await command.calls(),
      mode === "pending" ? [] : mode === "existing" ? [view("0.1.1")] : [view("0.1.1"), publish],
    )
    assert.ok((await command.directories()).every((directory) => directory === root))
  })
}
