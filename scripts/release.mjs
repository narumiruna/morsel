import { execFileSync } from "node:child_process"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import semver from "semver"
import { runChangeset } from "./changeset.mjs"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))

function isStableVersion(version) {
  return (
    typeof version === "string" &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    semver.valid(version) === version
  )
}

export async function publishRepository(root = repositoryRoot, env = process.env) {
  const run = (command, args) =>
    execFileSync(command, args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()

  const tags = run("git", ["tag", "--list", "v*", "--sort=-version:refname"])
    .split("\n")
    .filter((tag) => tag.startsWith("v") && isStableVersion(tag.slice(1)))
  const latestTag = tags[0]
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  if (!isStableVersion(version)) {
    throw new Error("The repository version must be a stable semantic version.")
  }
  const tag = `v${version}`
  if (latestTag && semver.lt(version, latestTag.slice(1))) {
    throw new Error(
      `Repository version ${tag} is older than ${latestTag}; update the root version first.`,
    )
  }

  const releasedTags = new Set(
    run("gh", ["api", "--paginate", "repos/{owner}/{repo}/releases", "--jq", ".[].tag_name"])
      .split("\n")
      .filter(Boolean),
  )

  // Recover the immutable tag before considering newer changesets on main.
  if (latestTag && !releasedTags.has(latestTag)) {
    try {
      run("git", ["merge-base", "--is-ancestor", `${latestTag}^{commit}`, "HEAD"])
    } catch {
      throw new Error(`Unreleased tag ${latestTag} is not on main.`)
    }
    return latestTag
  }

  const plan = JSON.parse(await runChangeset(["status"], root))
  if (plan.changesets.length > 0) return null

  if (releasedTags.has(tag)) return null

  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8")
  if (!changelog.split("\n").includes(`## ${version}`)) {
    throw new Error("CHANGELOG.md must contain the repository version.")
  }

  run("git", ["tag", tag])
  run("git", ["push", "origin", `refs/tags/${tag}`])
  return tag
}

if (import.meta.main) {
  try {
    const tag = await publishRepository()
    if (tag && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\n`)
    }
    console.log(tag ? `Repository release: ${tag}` : "No repository release to publish.")
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
