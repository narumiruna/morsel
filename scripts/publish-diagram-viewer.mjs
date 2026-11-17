import { execFileSync } from "node:child_process"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import semver from "semver"
import { runChangeset } from "./changeset.mjs"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
const packageName = "@narumitw/diagram-viewer"
const packageDirectory = "packages/diagram-viewer"
const registry = "--registry=https://registry.npmjs.org"

function isStableVersion(version) {
  return (
    typeof version === "string" &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    semver.valid(version) === version
  )
}

export async function publishDiagramViewer(root = repositoryRoot, env = process.env) {
  const run = (args) =>
    execFileSync("npm", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()

  const pkg = JSON.parse(await readFile(join(root, packageDirectory, "package.json"), "utf8"))
  if (pkg.name !== packageName) {
    throw new Error(`The package in ${packageDirectory} must be named ${packageName}.`)
  }
  if (pkg.private || pkg.publishConfig?.access !== "public") {
    throw new Error(
      `${packageName} must not be private and must set publishConfig.access to public.`,
    )
  }
  const { version } = pkg
  if (!isStableVersion(version)) {
    throw new Error("The diagram-viewer version must be a stable semantic version.")
  }

  const plan = JSON.parse(await runChangeset(["status"], root))
  if (plan.releases.some((release) => release.name === packageName && release.type !== "none")) {
    return null
  }

  let response
  try {
    response = run(["view", `${packageName}@${version}`, "version", "--json", registry])
  } catch (error) {
    // Only npm's structured E404 response proves that this exact version is absent.
    let failure
    try {
      failure = JSON.parse(error.stdout)
    } catch {
      throw new Error("Cannot determine the published diagram-viewer version.", { cause: error })
    }
    if (
      failure?.error?.code !== "E404" ||
      !Number.isInteger(error.status) ||
      error.status <= 0 ||
      error.signal
    ) {
      throw new Error("Cannot determine the published diagram-viewer version.", { cause: error })
    }
  }
  if (response !== undefined) {
    let publishedVersion
    try {
      publishedVersion = JSON.parse(response)
    } catch (error) {
      throw new Error("The npm registry returned invalid JSON.", { cause: error })
    }
    if (publishedVersion !== version) {
      throw new Error("The npm registry did not return the exact diagram-viewer version.")
    }
    return null
  }

  const changelog = await readFile(join(root, packageDirectory, "CHANGELOG.md"), "utf8")
  if (!changelog.split(/\r?\n/).includes(`## ${version}`)) {
    throw new Error("The diagram-viewer CHANGELOG.md must contain the package version.")
  }

  // The package's prepack script builds its compiled source.
  run(["publish", "--workspace", packageName, "--access", "public", "--provenance", registry])
  return version
}

if (import.meta.main) {
  try {
    const version = await publishDiagramViewer()
    if (version && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `published-version=${version}\n`)
    }
    console.log(
      version ? `Published ${packageName}@${version}` : "No diagram-viewer release to publish.",
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
