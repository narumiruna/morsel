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
import { runInNewContext } from "node:vm"
import { runChangeset } from "./changeset.mjs"
import { publishRepository } from "./release.mjs"
import { releasePrBody } from "./release-pr.mjs"

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

test("release PR notes describe a generated root-only release without older entries", async (t) => {
  const root = await fixture(t)
  await add(root, "minor", "Add saved themes and Mermaid styles.")
  await add(root, "patch", "Keep diagram toolbars consistent.")
  await runChangeset(["version"], root)
  const before = git(root, "status", "--porcelain")

  const body = await releasePrBody(root)
  assert.ok(body.includes(`# Releases\n\n## ${name}@0.1.0\n`))
  assert.ok(body.includes("### Minor Changes"))
  assert.ok(body.includes("Add saved themes and Mermaid styles."))
  assert.ok(body.includes("Keep diagram toolbars consistent."))
  assert.ok(body.includes("No npm packages are published."))
  assert.doesNotMatch(body, /Initial release|## 0\.0\.1|publish to npm|setup this action/)
  for (const workspace of workspaceNames) {
    assert.ok(!body.includes(`@narumitw/morsel-${workspace}`))
    assert.equal((await json(join(root, "packages", workspace, "package.json"))).version, "0.1.0")
  }
  assert.equal(git(root, "status", "--porcelain"), before)
})

for (const newline of ["\n", "\r\n"]) {
  test(`release PR notes select the exact version and preserve fenced Markdown (${JSON.stringify(newline)})`, async (t) => {
    const root = await fixture(t, "0.0.2")
    const notes = [
      "### Patch Changes",
      "",
      "- Current release notes.",
      "",
      "```markdown",
      "## Example heading",
      "```",
      "",
      "~~~markdown",
      "## Another example",
      "~~~",
      "",
      "Current final paragraph.",
    ].join("\n")
    await writeFile(
      join(root, "CHANGELOG.md"),
      [
        "# Morsel",
        "",
        "## 0.0.20",
        "",
        "Unrelated notes.",
        "",
        "```markdown",
        "## 0.0.2",
        "Not the real entry.",
        "```",
        "",
        "## 0.0.2",
        "",
        notes,
        "",
        "## 0.0.1",
        "",
        "Old notes.",
      ]
        .join("\n")
        .replaceAll("\n", newline),
    )
    const body = await releasePrBody(root)
    assert.ok(body.endsWith(`${notes}\n`))
    assert.doesNotMatch(body, /Unrelated notes|Not the real entry|Old notes/)
  })
}

for (const [description, changelog] of [
  ["missing", "## 0.0.1\n\nOld notes.\n"],
  ["empty", "## 0.0.2\n\n## 0.0.1\n\nOld notes.\n"],
  ["heading-only", "## 0.0.2\n\n### Patch Changes\n\n## 0.0.1\n\nOld notes.\n"],
]) {
  test(`release PR notes reject ${description} current-version entries`, async (t) => {
    const root = await fixture(t, "0.0.2")
    await writeFile(join(root, "CHANGELOG.md"), changelog)
    const before = git(root, "status", "--porcelain")
    await assert.rejects(releasePrBody(root), /must contain release notes for 0\.0\.2/)
    assert.equal(git(root, "status", "--porcelain"), before)
  })
}

for (const valid of [true, false]) {
  test(`release PR CLI ${valid ? "prints root notes from a workspace" : "fails without printing an empty body"}`, async (t) => {
    const root = await fixture(t)
    await mkdir(join(root, "scripts"))
    const script = join(root, "scripts/release-pr.mjs")
    await copyFile(join(repositoryRoot, "scripts/release-pr.mjs"), script)
    if (!valid) await writeFile(join(root, "CHANGELOG.md"), "# Morsel\n")
    const result = spawnSync(process.execPath, [script], {
      cwd: join(root, "packages/viewer"),
      encoding: "utf8",
    })
    assert.equal(result.status, valid ? 0 : 1, result.stderr)
    if (valid) {
      assert.equal(result.stdout, await releasePrBody(root))
      assert.equal(result.stderr, "")
    } else {
      assert.equal(result.stdout, "")
      assert.match(result.stderr, /must contain release notes/)
    }
  })
}

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

for (const released of [true, false]) {
  test(`an outdated root with pending changesets cannot bypass ${released ? "published" : "unreleased"} tags`, async (t) => {
    const root = await fixture(t, "0.0.1")
    await add(root, "patch")
    const before = git(root, "status", "--porcelain")
    const command = await publication(t, root, {
      tags: ["v0.1.0"],
      releasedTags: released ? ["v0.1.0"] : [],
    })
    await assert.rejects(command.run(), /older than v0\.1\.0/)
    assert.deepEqual(await command.writes(), [])
    assert.equal(
      (await command.calls()).some(([command]) => command === "gh"),
      false,
    )
    assert.equal(git(root, "status", "--porcelain"), before)
    assert.equal((await json(join(root, "package.json"))).version, "0.0.1")
  })
}

test("an invalid stable root with pending changesets cannot bypass recovery", async (t) => {
  const root = await fixture(t, "0.1.1-beta.1")
  await add(root, "patch")
  const before = git(root, "status", "--porcelain")
  const command = await publication(t, root, { tags: ["v0.1.0"], releasedTags: [] })
  await assert.rejects(command.run(), /stable semantic version/)
  assert.deepEqual(await command.writes(), [])
  assert.equal(
    (await command.calls()).some(([command]) => command === "gh"),
    false,
  )
  assert.equal(git(root, "status", "--porcelain"), before)
})

test("an equal baseline permits only a root patch version PR", async (t) => {
  const root = await fixture(t, "0.1.0")
  await add(root, "patch")
  git(root, "add", "--", ".changeset")
  git(root, "commit", "--quiet", "-m", "test: add patch to published baseline")
  const head = git(root, "rev-parse", "HEAD")
  const lockfile = await json(join(root, "package-lock.json"))
  const workspaces = await Promise.all(
    workspaceNames.map((workspace) =>
      readFile(join(root, `packages/${workspace}/package.json`), "utf8"),
    ),
  )
  const command = await publication(t, root, { tags: ["v0.1.0"], releasedTags: ["v0.1.0"] })
  assert.equal(await command.run(), null)
  const plan = JSON.parse(await runChangeset(["status"], root))
  assert.equal(plan.releases.length, 1)
  assert.equal(plan.releases[0].name, name)
  assert.equal(plan.releases[0].oldVersion, "0.1.0")
  assert.equal(plan.releases[0].newVersion, "0.1.1")
  assert.equal(await runChangeset(["version"], root), "Versioned repository: v0.1.1")
  assert.equal((await json(join(root, "package.json"))).version, "0.1.1")
  lockfile.version = "0.1.1"
  lockfile.packages[""].version = "0.1.1"
  assert.deepEqual(await json(join(root, "package-lock.json")), lockfile)
  for (const [index, workspace] of workspaceNames.entries()) {
    assert.equal(
      await readFile(join(root, `packages/${workspace}/package.json`), "utf8"),
      workspaces[index],
    )
    assert.deepEqual(await readdir(join(root, `packages/${workspace}`)), ["package.json"])
  }
  assert.deepEqual((await readdir(join(root, ".changeset"))).sort(), ["README.md", "config.json"])
  assert.deepEqual(await command.writes(), [])
  assert.equal(git(root, "rev-parse", "HEAD"), head)
  assert.equal(git(root, "tag", "--list"), "")
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
  ["older version", "0.0.1", { tags: ["v0.0.2"], releasedTags: ["v0.0.2"] }, /older than/],
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

test("workflow uses the action only for root version PRs", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
  assert.ok(workflow.includes("  workflow_dispatch:\n"))
  assert.ok(workflow.includes("  push:\n    branches: [main]\n"))
  assert.ok(workflow.includes("node-version: 26"))
  assert.ok(workflow.includes("pull-requests: write"))
  assert.ok(workflow.includes("uses: changesets/action@v2"))
  assert.ok(workflow.includes("version-script: npm run release:version"))
  assert.ok(workflow.includes("push-with-git-cli: true"))
  assert.ok(workflow.includes("create-github-releases: false"))
  assert.ok(workflow.includes("push-git-tags: false"))
  assert.match(workflow, /name: Prepare version PR\n\s+id: version\n\s+uses: changesets\/action@v2/)
  assert.ok(
    workflow.indexOf("run: npm run release\n") < workflow.indexOf("uses: changesets/action@v2"),
  )
  assert.ok(workflow.includes("if: needs.publish.outputs.tag != ''"))
  assert.ok(workflow.includes("uses: ./.github/workflows/container.yml"))
  assert.ok(workflow.includes("needs: [publish, container]"))
  assert.doesNotMatch(workflow, /publish-script:|npm publish|registry-url:|id-token:/)
})

test("version PR descriptions use the root changelog after the action prepares the branch", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
  assert.match(workflow, /name: Prepare version PR\n\s+id: version\n\s+uses: changesets\/action@v2/)
  const describe = workflow
    .split("      - name: Describe repository release\n")[1]
    ?.split("\n  container:")[0]
  assert.ok(describe, "The workflow must replace the workspace-only description")
  assert.ok(describe.includes("if: steps.version.outputs.pr-number != ''"))
  assert.match(describe, /GH_TOKEN: \$\{\{ github\.token \}\}/)
  assert.match(describe, /GH_REPO: \$\{\{ github\.repository \}\}/)
  assert.match(describe, /PR_NUMBER: \$\{\{ steps\.version\.outputs\.pr-number \}\}/)
  assert.ok(describe.includes('node scripts/release-pr.mjs > "$RUNNER_TEMP/release-pr.md"'))
  assert.ok(describe.includes('gh pr edit "$PR_NUMBER" --body-file "$RUNNER_TEMP/release-pr.md"'))
})

for (const valid of [true, false]) {
  test(`the description step ${valid ? "updates the returned PR with root notes" : "does not call GitHub when notes are empty"}`, async (t) => {
    const root = await fixture(t, "0.0.2")
    await mkdir(join(root, "scripts"))
    await copyFile(
      join(repositoryRoot, "scripts/release-pr.mjs"),
      join(root, "scripts/release-pr.mjs"),
    )
    if (!valid) await writeFile(join(root, "CHANGELOG.md"), "## 0.0.2\n\n### Patch Changes\n")
    const bin = join(root, "release commands")
    const log = join(bin, "github.json")
    await mkdir(bin)
    await writeFile(log, "")
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs")
const args = process.argv.slice(2)
writeFileSync(process.env.RELEASE_PR_TEST_LOG, JSON.stringify({ args, body: readFileSync(args[4], "utf8") }))
`,
    )
    await chmod(join(bin, "gh"), 0o700)

    const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
    const describe = workflow.split("      - name: Describe repository release\n")[1]
    const run = describe?.match(/ {8}run: \|\n((?: {10}.*\n)+)/)
    assert.ok(run, "The description step must generate notes before editing the PR")
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", run[1].replace(/^ {10}/gm, "")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        RUNNER_TEMP: bin,
        PR_NUMBER: "151",
        RELEASE_PR_TEST_LOG: log,
      },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, valid ? 0 : 1, result.stderr)
    if (valid) {
      assert.deepEqual(await json(log), {
        args: ["pr", "edit", "151", "--body-file", join(bin, "release-pr.md")],
        body: await releasePrBody(root),
      })
    } else {
      assert.equal(await readFile(log, "utf8"), "")
      assert.match(result.stderr, /must contain release notes/)
    }
  })
}

test("publication deploys its tag only after the GitHub release succeeds", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
  const deploy = workflow.split("\n  deploy:\n")[1]
  assert.ok(deploy, "Publish must call Deploy directly")
  assert.match(deploy, /^ {4}needs: \[publish, release\]$/m)
  assert.match(deploy, /^ {4}if: needs\.publish\.outputs\.tag != ''$/m)
  assert.match(deploy, /^ {4}permissions:\n {6}contents: read$/m)
  assert.match(deploy, /^ {4}uses: \.\/\.github\/workflows\/deploy\.yml$/m)
  assert.match(deploy, /^ {4}with:\n {6}tag: \$\{\{ needs\.publish\.outputs\.tag \}\}$/m)
  assert.match(deploy, /^ {4}secrets: inherit$/m)
  assert.doesNotMatch(deploy, /always\(\)|continue-on-error:/)
})

test("deployment accepts release tags and manual branches without automatic PR deployments", async () => {
  const deploy = await readFile(join(repositoryRoot, ".github/workflows/deploy.yml"), "utf8")
  assert.ok(
    deploy.includes(
      "  workflow_call:\n    inputs:\n      tag:\n        description: Git tag to deploy\n        required: true\n        type: string\n",
    ),
  )
  assert.ok(deploy.includes("  workflow_dispatch:\n"))
  assert.ok(deploy.includes('  push:\n    tags:\n      - "v*.*.*"\n'))
  const condition = deploy.match(/^ {4}if: (.+)$/m)?.[1]
  assert.equal(
    condition,
    "github.event_name == 'workflow_dispatch' || github.event_name == 'push' || github.ref == 'refs/heads/main'",
  )
  for (const [event, ref, expected] of [
    ["workflow_dispatch", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/narumi/feat/deploy-test", true],
    ["workflow_dispatch", "refs/tags/v0.2.1", true],
    ["push", "refs/tags/v0.2.1", true],
    ["push", "refs/heads/main", true],
    ["pull_request", "refs/pull/123/merge", false],
  ]) {
    assert.equal(
      runInNewContext(condition, { github: { event_name: event, ref } }),
      expected,
      `${event} from ${ref}`,
    )
  }
  assert.match(
    deploy,
    /ref: \$\{\{ inputs\.tag && format\('refs\/tags\/\{0\}', inputs\.tag\) \|\| github\.sha \}\}/,
  )
  assert.ok(deploy.includes("persist-credentials: false"))
  assert.ok(deploy.includes("concurrency:\n  group: deploy\n  cancel-in-progress: false\n"))
  assert.doesNotMatch(deploy, /branches:|pull_request(?:_target)?:/)
})

test("deployment image identifies the checked-out tag instead of a newer triggering commit", async (t) => {
  const root = await fixture(t)
  const taggedSha = git(root, "rev-parse", "HEAD")
  git(root, "tag", "v0.0.1")
  git(root, "commit", "--quiet", "--allow-empty", "-m", "test: advance main beyond release")
  const triggeringSha = git(root, "rev-parse", "HEAD")
  assert.notEqual(taggedSha, triggeringSha)
  git(root, "checkout", "--quiet", "--detach", "refs/tags/v0.0.1")

  const bin = join(root, "bin")
  const log = join(root, "docker.json")
  const output = join(root, "github-env")
  await mkdir(bin)
  await writeFile(output, "")
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs")
writeFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify(process.argv.slice(2)))
`,
  )
  await chmod(join(bin, "docker"), 0o700)

  const deploy = await readFile(join(repositoryRoot, ".github/workflows/deploy.yml"), "utf8")
  const build = deploy.match(/ {6}- name: Build image\n {8}run: \|\n((?: {10}.*\n)+)/)
  assert.ok(build, "Build image must derive and export the checked-out image")
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", build[1].replace(/^ {10}/gm, "")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GITHUB_SHA: triggeringSha,
      GITHUB_ENV: output,
      DEPLOY_TEST_LOG: log,
    },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await json(log), ["build", "--pull", "--tag", `morsel:${taggedSha}`, "."])
  assert.equal(await readFile(output, "utf8"), `MORSEL_IMAGE=morsel:${taggedSha}\n`)
})
