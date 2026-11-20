import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyReleasePlan } from "@changesets/apply-release-plan"
import { assembleReleasePlan } from "@changesets/assemble-release-plan"
import { readConfig } from "@changesets/config"
import { readChangesets } from "@changesets/read"
import { writeChangeset } from "@changesets/write"
import { NpmTool } from "@manypkg/tools"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
const bumpTypes = ["patch", "minor", "major"]
const dependencyTypes = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]
const usage = [
  'npm run changeset -- add <patch|minor|major> "Summary" [--package <name>]',
  "npm run changeset -- status",
  "npm run release:version",
].join("\n")

export async function runChangeset(args, root = repositoryRoot) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) return usage

  const [command, type, ...message] = args
  let target
  const optionIndex = message.indexOf("--package")
  if (optionIndex !== -1) {
    if (optionIndex !== message.length - 2 || optionIndex === 0) throw new Error(usage)
    target = message.pop()
    message.pop()
  }
  if (message.some((part) => part.startsWith("--")) || target?.startsWith("--")) {
    throw new Error(usage)
  }
  const summary = message.join(" ").trim()
  if (
    !(command === "add" && bumpTypes.includes(type) && summary) &&
    !((command === "status" || command === "version") && args.length === 1)
  ) {
    throw new Error(usage)
  }

  const packages = await NpmTool.getPackages(root)
  packages.packages.unshift(packages.rootPackage)
  const { name } = packages.rootPackage.packageJson
  if (target !== undefined && target !== name) {
    throw new Error(`Unknown release target ${target}. Allowed target: ${name}.`)
  }
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
  for (const release of plan.releases) {
    if (release.type !== "none" && release.name !== name) {
      throw new Error(`Release plan must not version ${release.name}.`)
    }
  }
  if (command === "status") return JSON.stringify(plan, null, 2)
  const release = plan.releases.find(({ type }) => type !== "none")
  if (!release) throw new Error("No unreleased repository changesets.")

  const lockfilePath = join(root, "package-lock.json")
  const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"))
  if (
    lockfile.name !== name ||
    lockfile.version !== packages.rootPackage.packageJson.version ||
    lockfile.packages?.[""]?.name !== name
  ) {
    throw new Error("package-lock.json must describe the repository root.")
  }

  // Check all metadata that applyReleasePlan can change before it consumes changesets.
  for (const pkg of packages.packages) {
    const key = pkg.relativeDir === "." ? "" : pkg.relativeDir
    const entry = lockfile.packages[key]
    if (entry?.name !== pkg.packageJson.name || entry?.version !== pkg.packageJson.version) {
      throw new Error(
        `package-lock.json must match ${key || "the repository root"} name and version.`,
      )
    }
    for (const dependencyType of dependencyTypes) {
      for (const [dependency, version] of Object.entries(pkg.packageJson[dependencyType] ?? {})) {
        if (entry[dependencyType]?.[dependency] !== version) {
          throw new Error(
            `package-lock.json must match ${key || "the repository root"} ${dependencyType}.${dependency}.`,
          )
        }
      }
    }
  }

  await applyReleasePlan(plan, packages, config)
  for (const pkg of packages.packages) {
    const updated = JSON.parse(await readFile(join(pkg.dir, "package.json"), "utf8"))
    const key = pkg.relativeDir === "." ? "" : pkg.relativeDir
    const entry = lockfile.packages[key]
    if (updated.version !== pkg.packageJson.version) {
      entry.version = updated.version
      if (key === "") lockfile.version = updated.version
    }
    for (const dependencyType of dependencyTypes) {
      for (const [dependency, version] of Object.entries(updated[dependencyType] ?? {})) {
        if (version !== pkg.packageJson[dependencyType]?.[dependency]) {
          entry[dependencyType][dependency] = version
        }
      }
    }
  }
  await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`)
  return `Versioned repository: v${release.newVersion}`
}

if (import.meta.main) {
  try {
    console.log(await runChangeset(process.argv.slice(2)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
