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
import { publishRepository } from "./release.mjs"

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

async function publication(t, root, state = {}) {
  const bin = await mkdtemp(join(tmpdir(), "morsel-release-commands-"))
  t.after(() => rm(bin, { recursive: true, force: true }))
  const log = join(bin, "commands.jsonl")
  await writeFile(log, "")
  const stub = [
    "#!/usr/bin/env node",
    'const { appendFileSync } = require("node:fs")',
    'const { basename } = require("node:path")',
    "const state = JSON.parse(process.env.RELEASE_TEST_STATE)",
    "const command = basename(process.argv[1])",
    "const args = process.argv.slice(2)",
    'appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify([command, ...args]) + "\\n")',
    'if (command === "gh" && args[0] === "api") {',
    '  if (state.apiFailure) { console.error("GitHub API failed"); process.exit(1) }',
    '  console.log(state.releasedTags.join("\\n"))',
    '} else if (command === "git" && args[0] === "tag" && args[1] === "--list") {',
    '  console.log(state.tags.join("\\n"))',
    '} else if (command === "git" && args[0] === "merge-base") process.exit(state.foreignTag ? 1 : 0)',
    'else if (command === "git" && args[0] === "tag") process.exit(state.tagFailure ? 1 : 0)',
    'else if (command === "git" && args[0] === "push") process.exit(state.pushFailure ? 1 : 0)',
    'else { console.error("Unexpected release command", command, args); process.exit(90) }',
  ].join("\n")
  for (const command of ["git", "gh", "npm"]) {
    await writeFile(join(bin, command), stub)
    await chmod(join(bin, command), 0o700)
  }
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    RELEASE_TEST_LOG: log,
    RELEASE_TEST_STATE: JSON.stringify({
      tags: ["v0.0.1"],
      releasedTags: ["v0.0.1"],
      ...state,
    }),
  }
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return {
    env,
    run: () => publishRepository(root, env),
    calls,
    writes: async () =>
      (await calls()).filter(
        ([command, operation, argument]) =>
          command === "git" &&
          (operation === "push" || (operation === "tag" && argument !== "--list")),
      ),
  }
}

test("publication creates only the root tag without changing package versions", async (t) => {
  const root = await fixture(t, "0.0.2")
  const command = await publication(t, root)
  assert.equal(await command.run(), "v0.0.2")
  assert.deepEqual(await command.writes(), [
    ["git", "tag", "v0.0.2"],
    ["git", "push", "origin", "refs/tags/v0.0.2"],
  ])
  assert.equal(git(root, "status", "--porcelain"), "")
  for (const workspace of workspaceNames) {
    assert.equal((await json(join(root, "packages", workspace, "package.json"))).version, "0.1.0")
  }
})

test("publication supports a repository with no stable tags", async (t) => {
  const root = await fixture(t, "0.0.2")
  const command = await publication(t, root, {
    tags: ["v1.0.0-beta.1"],
    releasedTags: [],
  })
  assert.equal(await command.run(), "v0.0.2")
  assert.equal((await command.writes()).length, 2)
})

test("completed publication is a no-op, including repeated main pushes", async (t) => {
  const root = await fixture(t)
  const command = await publication(t, root)
  assert.equal(await command.run(), null)
  assert.equal(await command.run(), null)
  assert.deepEqual(await command.writes(), [])
})

test("pending changesets are left for the action's version PR", async (t) => {
  const root = await fixture(t)
  await add(root, "minor")
  const before = git(root, "status", "--porcelain")
  const command = await publication(t, root)
  assert.equal(await command.run(), null)
  assert.deepEqual(await command.writes(), [])
  assert.equal(git(root, "status", "--porcelain"), before)
  assert.equal((await json(join(root, "package.json"))).version, "0.0.1")
})

test("a retry recovers an unreleased tag before processing newer changesets", async (t) => {
  const root = await fixture(t, "0.0.3")
  await add(root, "minor")
  const before = await readdir(join(root, ".changeset"))
  const command = await publication(t, root, { tags: ["v0.0.2", "v0.0.1"] })
  assert.equal(await command.run(), "v0.0.2")
  assert.deepEqual(await command.writes(), [])
  assert.deepEqual(
    (await command.calls()).find(
      ([command, operation]) => command === "git" && operation === "merge-base",
    ),
    ["git", "merge-base", "--is-ancestor", "v0.0.2^{commit}", "HEAD"],
  )
  assert.deepEqual(await readdir(join(root, ".changeset")), before)
})

test("recovery still permits a root-only version PR for pending changesets", async (t) => {
  const root = await fixture(t, "0.0.2")
  await add(root, "minor")
  git(root, "add", "--", ".changeset")
  git(root, "commit", "--quiet", "-m", "test: add pending release during recovery")
  const command = await publication(t, root, { tags: ["v0.0.2", "v0.0.1"] })
  const tag = await command.run()
  assert.equal(tag, "v0.0.2")
  assert.equal(await runChangeset(["version"], root), "Versioned repository: v0.1.0")
  assert.equal((await json(join(root, "package.json"))).version, "0.1.0")
  assert.deepEqual(await command.writes(), [])
  assert.deepEqual((await readdir(join(root, ".changeset"))).sort(), ["README.md", "config.json"])
})

for (const [description, version, state, expected] of [
  ["older version", "0.0.1", { tags: ["v0.0.2"], releasedTags: ["v0.0.2"] }, /must be newer/],
  ["prerelease", "0.0.2-beta.1", {}, /stable semantic version/],
  ["foreign unreleased tag", "0.0.2", { tags: ["v0.0.2"], foreignTag: true }, /is not on main/],
  ["GitHub API failure", "0.0.2", { apiFailure: true }, /GitHub API failed/],
]) {
  test(`publication rejects ${description} without tagging`, async (t) => {
    const root = await fixture(t, version)
    const command = await publication(t, root, state)
    await assert.rejects(command.run(), expected)
    assert.deepEqual(await command.writes(), [])
  })
}

test("publication requires a matching root changelog entry", async (t) => {
  const root = await fixture(t, "0.0.2")
  await writeFile(join(root, "CHANGELOG.md"), "# Morsel\n\n## 0.0.1\n")
  const command = await publication(t, root)
  await assert.rejects(command.run(), /CHANGELOG.md must contain/)
  assert.deepEqual(await command.writes(), [])
})

test("publication rejects workspace changesets without creating tags", async (t) => {
  const root = await fixture(t, "0.0.2")
  await writeFile(
    join(root, ".changeset/invalid.md"),
    '---\n"@narumitw/morsel-client": patch\n---\n\nWrong release target.\n',
  )
  const command = await publication(t, root)
  await assert.rejects(command.run(), /must target only @narumitw\/morsel/)
  assert.deepEqual(await command.writes(), [])
})

for (const [description, state, writes] of [
  ["tag creation", { tagFailure: true }, [["git", "tag", "v0.0.2"]]],
  [
    "tag push",
    { pushFailure: true },
    [
      ["git", "tag", "v0.0.2"],
      ["git", "push", "origin", "refs/tags/v0.0.2"],
    ],
  ],
]) {
  test(`publication stops on failed ${description}`, async (t) => {
    const root = await fixture(t, "0.0.2")
    const command = await publication(t, root, state)
    await assert.rejects(command.run(), /Command failed/)
    assert.deepEqual(await command.writes(), writes)
  })
}

for (const [version, expected] of [
  ["0.0.2", "tag=v0.0.2\n"],
  ["0.0.1", ""],
]) {
  test(`release CLI emits the correct job output for ${version}`, async (t) => {
    const root = await fixture(t, version)
    await mkdir(join(root, "scripts"))
    for (const filename of ["release.mjs", "changeset.mjs"]) {
      await copyFile(join(repositoryRoot, "scripts", filename), join(root, "scripts", filename))
    }
    await symlink(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "dir")
    const command = await publication(t, root)
    const output = join(root, "output")
    await writeFile(output, "")
    const result = spawnSync(process.execPath, [join(root, "scripts/release.mjs")], {
      cwd: join(root, "packages/viewer"),
      env: { ...command.env, GITHUB_OUTPUT: output },
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await readFile(output, "utf8"), expected)
  })
}

test("workflow uses the action only for root version PRs and keeps manual deployment", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
  assert.ok(workflow.includes("  workflow_dispatch:\n"))
  assert.ok(workflow.includes("  push:\n    branches: [main]\n"))
  assert.ok(workflow.includes("node-version: 26"))
  assert.ok(workflow.includes("pull-requests: write"))
  assert.ok(workflow.includes("uses: changesets/action@v2"))
  assert.ok(workflow.includes("version-script: npm run release:version"))
  assert.ok(workflow.includes("create-github-releases: false"))
  assert.ok(workflow.includes("push-git-tags: false"))
  assert.match(workflow, /name: Prepare version PR\n\s+uses: changesets\/action@v2/)
  assert.ok(
    workflow.indexOf("run: npm run release\n") < workflow.indexOf("uses: changesets/action@v2"),
  )
  assert.ok(workflow.includes("if: needs.publish.outputs.tag != ''"))
  assert.ok(workflow.includes("uses: ./.github/workflows/container.yml"))
  assert.ok(workflow.includes("needs: [publish, container]"))
  assert.doesNotMatch(workflow, /publish-script:|npm publish|registry-url:|id-token:/)
  const deploy = await readFile(join(repositoryRoot, ".github/workflows/deploy.yml"), "utf8")
  assert.ok(deploy.includes("  workflow_dispatch:\n"))
  assert.ok(!deploy.includes("  push:"))
})
