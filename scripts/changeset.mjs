import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyReleasePlan } from "@changesets/apply-release-plan"
import { assembleReleasePlan } from "@changesets/assemble-release-plan"
import { readConfig } from "@changesets/config"
import { readChangesets } from "@changesets/read"
import { writeChangeset } from "@changesets/write"
import { RootTool } from "@manypkg/tools"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
const bumpTypes = ["patch", "minor", "major"]
const usage = [
  'npm run changeset -- add <patch|minor|major> "Summary"',
  "npm run changeset -- status",
  "npm run release:version",
].join("\n")

export async function runChangeset(args, root = repositoryRoot) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) return usage

  const [command, type, ...message] = args
  const summary = message.join(" ").trim()
  if (
    !(command === "add" && bumpTypes.includes(type) && summary) &&
    !((command === "status" || command === "version") && args.length === 1)
  ) {
    throw new Error(usage)
  }

  // Bypass npm workspace discovery: the root package represents the whole repository.
  const packages = await RootTool.getPackages(root)
  const { name } = packages.rootPackage.packageJson
  const { config, warnings, errors } = await readConfig(root, packages)
  if (errors) throw new Error(errors.join("\n"))
  for (const warning of warnings) console.warn(warning)

  if (command === "add") {
    const id = await writeChangeset({ releases: [{ name, type }], summary }, root, {
      format: config.format,
    })
    return `Created .changeset/${id}.md`
  }

  const changesets = await readChangesets(root)
  for (const changeset of changesets) {
    for (const release of changeset.releases) {
      if (release.name !== name || !bumpTypes.includes(release.type)) {
        throw new Error(
          `.changeset/${changeset.id}.md must target only ${name} with patch, minor, or major.`,
        )
      }
    }
  }
  const plan = assembleReleasePlan(changesets, packages, config)
  if (command === "status") return JSON.stringify(plan, null, 2)
  if (plan.releases.length === 0) throw new Error("No unreleased repository changesets.")

  const lockfilePath = join(root, "package-lock.json")
  const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"))
  if (lockfile.packages?.[""]?.name !== name) {
    throw new Error("package-lock.json must describe the repository root.")
  }

  await applyReleasePlan(plan, packages, config)
  const { newVersion } = plan.releases[0]
  lockfile.version = newVersion
  lockfile.packages[""].version = newVersion
  await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`)
  return `Versioned repository: v${newVersion}`
}

if (import.meta.main) {
  try {
    console.log(await runChangeset(process.argv.slice(2)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
