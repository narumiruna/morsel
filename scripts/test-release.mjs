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

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
const name = "@narumitw/morsel"
const workspaceNames = ["client", "viewer"]
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: "Release Test",
  GIT_AUTHOR_EMAIL: "release-test@example.invalid",
  GIT_COMMITTER_NAME: "Release Test",
  GIT_COMMITTER_EMAIL: "release-test@example.invalid",
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"))
}

function git(root, ...args) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf8",
    env: gitEnvironment,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function fixture(t, version = "0.0.1") {
  const root = await mkdtemp(join(tmpdir(), "morsel-release-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, ".changeset"))
  await copyFile(
    join(repositoryRoot, ".changeset/config.json"),
    join(root, ".changeset/config.json"),
  )
  await writeFile(join(root, ".changeset/README.md"), "# Repository Changesets\n")
  const pkg = { name, version, private: true, workspaces: ["packages/*"] }
  const packages = { "": pkg }
  for (const workspace of workspaceNames) {
    const path = `packages/${workspace}`
    await mkdir(join(root, path), { recursive: true })
    const workspacePackage = {
      name: `@narumitw/morsel-${workspace}`,
      version: "0.1.0",
      private: workspace === "viewer",
    }
    await writeFile(join(root, path, "package.json"), JSON.stringify(workspacePackage))
    packages[path] = workspacePackage
  }
  await writeFile(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
  await writeFile(
    join(root, "package-lock.json"),
    `${JSON.stringify({ name, version, lockfileVersion: 3, requires: true, packages }, null, 2)}\n`,
  )
  await writeFile(join(root, "CHANGELOG.md"), `# Morsel\n\n## ${version}\n\nInitial release.\n`)
  git(root, "init", "--quiet", "--initial-branch=main")
  git(
    root,
    "add",
    "--",
    "package.json",
    "package-lock.json",
    "CHANGELOG.md",
    ".changeset",
    "packages",
  )
  git(root, "commit", "--quiet", "-m", "test: initialize release fixture")
  return root
}

async function add(root, type, summary = `Repository ${type} change.`) {
  return runChangeset(["add", type, summary], root)
}

test("changesets target only the repository and status does not write files", async (t) => {
  const root = await fixture(t)
  assert.match(await add(root, "patch"), /^Created \.changeset\/.+\.md$/)
  const before = git(root, "status", "--porcelain")
  const plan = JSON.parse(await runChangeset(["status"], root))
  assert.equal(plan.changesets.length, 1)
  assert.deepEqual(plan.changesets[0].releases, [{ name, type: "patch" }])
  assert.equal(plan.releases.length, 1)
  assert.equal(plan.releases[0].name, name)
  assert.equal(plan.releases[0].oldVersion, "0.0.1")
  assert.equal(plan.releases[0].newVersion, "0.0.2")
  assert.equal(git(root, "status", "--porcelain"), before)
})

for (const [types, version] of [
  [["patch"], "0.0.2"],
  [["minor"], "0.1.0"],
  [["major"], "1.0.0"],
  [["patch", "minor", "patch"], "0.1.0"],
  [["minor", "major"], "1.0.0"],
]) {
  test(`${types.join(" + ")} versions the repository once as ${version}`, async (t) => {
    const root = await fixture(t)
    const before = await json(join(root, "package-lock.json"))
    const workspaces = await Promise.all(
      workspaceNames.map((workspace) =>
        readFile(join(root, `packages/${workspace}/package.json`), "utf8"),
      ),
    )
    for (const [index, type] of types.entries()) await add(root, type, `Change ${index}: ${type}.`)
    git(root, "add", "--", ".changeset")
    git(root, "commit", "--quiet", "-m", "test: add repository changesets")
    const head = git(root, "rev-parse", "HEAD")

    assert.equal(await runChangeset(["version"], root), `Versioned repository: v${version}`)
    assert.equal((await json(join(root, "package.json"))).version, version)
    before.version = version
    before.packages[""].version = version
    assert.deepEqual(await json(join(root, "package-lock.json")), before)
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8")
    assert.ok(changelog.indexOf(`## ${version}\n`) < changelog.indexOf("## 0.0.1\n"))
    for (const [index, type] of types.entries())
      assert.ok(changelog.includes(`Change ${index}: ${type}.`))
    assert.deepEqual((await readdir(join(root, ".changeset"))).sort(), ["README.md", "config.json"])
    assert.deepEqual(JSON.parse(await runChangeset(["status"], root)).releases, [])
    for (const [index, workspace] of workspaceNames.entries()) {
      assert.equal(
        await readFile(join(root, `packages/${workspace}/package.json`), "utf8"),
        workspaces[index],
      )
      assert.deepEqual(await readdir(join(root, `packages/${workspace}`)), ["package.json"])
    }
    assert.equal(git(root, "rev-parse", "HEAD"), head)
    assert.equal(git(root, "tag", "--list"), "")
    await assert.rejects(runChangeset(["version"], root), /No unreleased repository changesets/)
  })
}

test("empty releases and unsupported arguments do not change files", async (t) => {
  const root = await fixture(t)
  assert.deepEqual(JSON.parse(await runChangeset(["status"], root)).releases, [])
  await assert.rejects(runChangeset(["version"], root), /No unreleased repository changesets/)
  for (const args of [
    ["add", "patch"],
    ["add", "patch", "  "],
    ["add", "invalid", "Summary"],
    ["status", "--unexpected"],
    ["version", "--unexpected"],
    ["publish"],
    ["tag"],
  ]) {
    await assert.rejects(runChangeset(args, root), /npm run changeset/)
  }
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("a mixed root and workspace changeset is rejected before any writes", async (t) => {
  const root = await fixture(t)
  const path = join(root, ".changeset/invalid.md")
  await writeFile(
    path,
    `---\n"${name}": patch\n"@narumitw/morsel-client": minor\n---\n\nInvalid target.\n`,
  )
  const before = git(root, "status", "--porcelain")
  for (const command of ["status", "version"]) {
    await assert.rejects(runChangeset([command], root), /must target only @narumitw\/morsel/)
  }
  assert.equal(git(root, "status", "--porcelain"), before)
  assert.equal((await json(join(root, "package.json"))).version, "0.0.1")
  assert.ok((await readFile(path, "utf8")).includes("Invalid target."))
})

test("an invalid lockfile is rejected before consuming changesets", async (t) => {
  const root = await fixture(t)
  await add(root, "patch")
  await writeFile(join(root, "package-lock.json"), "{}\n")
  const before = await readdir(join(root, ".changeset"))
  await assert.rejects(runChangeset(["version"], root), /must describe the repository root/)
  assert.deepEqual(await readdir(join(root, ".changeset")), before)
  assert.equal((await json(join(root, "package.json"))).version, "0.0.1")
})

test("configuration errors fail before generating a changeset", async (t) => {
  const root = await fixture(t)
  await writeFile(
    join(root, ".changeset/config.json"),
    JSON.stringify({ privatePackages: { version: false, tag: true } }),
  )
  await assert.rejects(add(root, "patch"), /privatePackages/)
  assert.deepEqual((await readdir(join(root, ".changeset"))).sort(), ["README.md", "config.json"])
})

test("CLI invocation from a workspace still targets the repository root", async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, "scripts"))
  const script = join(root, "scripts/changeset.mjs")
  await copyFile(join(repositoryRoot, "scripts/changeset.mjs"), script)
  await symlink(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "dir")
  const result = spawnSync(process.execPath, [script, "add", "patch", "Run from viewer."], {
    cwd: join(root, "packages/viewer"),
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(await runChangeset(["status"], root))
  assert.deepEqual(plan.changesets[0].releases, [{ name, type: "patch" }])
  assert.deepEqual(await readdir(join(root, "packages/viewer")), ["package.json"])
})

async function calculateTag(t, root, state = {}) {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
  const step = workflow
    .split("      - name: Calculate version\n")[1]
    .split("      - name: Tag version\n")[0]
  const script = step
    .split("        run: |\n")[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n")
  const bin = await mkdtemp(join(tmpdir(), "morsel-release-commands-"))
  t.after(() => rm(bin, { recursive: true, force: true }))
  const stub = `#!/usr/bin/env node
const { basename } = require("node:path")
const state = JSON.parse(process.env.RELEASE_TEST_STATE)
const args = process.argv.slice(2)
if (basename(process.argv[1]) === "gh") process.exit(state.unreleased ? 1 : 0)
if (args[0] === "tag" && args[1] === "--list") console.log(state.latestTag)
else if (args[0] === "rev-list") console.log(state.sameCommit ? "head" : "previous")
else if (args[0] === "rev-parse") console.log("head")
else if (args[0] === "merge-base") process.exit(state.foreignTag ? 1 : 0)
else if (args[0] === "show-ref") process.exit(args[3] === "refs/tags/" + state.latestTag ? 0 : 1)
else { console.error("Unexpected git command", args); process.exit(90) }
`
  for (const command of ["git", "gh"]) {
    await writeFile(join(bin, command), stub)
    await chmod(join(bin, command), 0o700)
  }
  const output = join(bin, "output")
  await writeFile(output, "")
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      RELEASE_TEST_STATE: JSON.stringify({ latestTag: "v0.0.1", ...state }),
    },
  })
  return { ...result, output: await readFile(output, "utf8") }
}

test("manual release uses the root version rather than workspace versions", async (t) => {
  const root = await fixture(t, "0.0.2")
  const result = await calculateTag(t, root)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, "tag=v0.0.2\ntag_exists=false\n")
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
  assert.match(workflow, /on:\n {2}workflow_dispatch:\n\n/)
  assert.doesNotMatch(workflow, /inputs\.bump|npm publish|changeset publish/)
})

for (const [description, version, state, expected] of [
  ["already tagged", "0.0.2", { latestTag: "v0.0.2" }, /already tagged/],
  ["older", "0.0.1", { latestTag: "v0.0.2" }, /must be newer/],
  ["prerelease", "0.0.2-beta.1", {}, /stable semantic version/],
  ["no new commits", "0.0.2", { sameCommit: true }, /No commits since/],
  ["foreign unreleased tag", "0.0.2", { unreleased: true, foreignTag: true }, /is not on main/],
]) {
  test(`manual release rejects ${description}`, async (t) => {
    const root = await fixture(t, version)
    const result = await calculateTag(t, root, state)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, expected)
    assert.equal(result.output, "")
  })
}

test("manual release requires consumed changesets and a matching changelog entry", async (t) => {
  const root = await fixture(t, "0.0.2")
  await add(root, "patch")
  let result = await calculateTag(t, root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /npm run release:version/)
  for (const path of await readdir(join(root, ".changeset"))) {
    if (path.endsWith(".md") && path !== "README.md") await rm(join(root, ".changeset", path))
  }
  await writeFile(join(root, "CHANGELOG.md"), "# Morsel\n\n## 0.0.1\n")
  result = await calculateTag(t, root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CHANGELOG.md must contain/)
})

test("release retry recovers the existing tag without consuming pending changesets", async (t) => {
  const root = await fixture(t, "0.0.2")
  await add(root, "minor")
  const before = await readdir(join(root, ".changeset"))
  const result = await calculateTag(t, root, { latestTag: "v0.0.2", unreleased: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, "tag=v0.0.2\ntag_exists=true\n")
  assert.deepEqual(await readdir(join(root, ".changeset")), before)
})
