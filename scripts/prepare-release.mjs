import { appendFile, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { NpmTool } from "@manypkg/tools"
import { runChangeset } from "./changeset.mjs"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))

export async function prepareRelease(root = repositoryRoot) {
  const plan = JSON.parse(await runChangeset(["status"], root))
  const releases = plan.releases.filter((release) => release.type !== "none")
  if (releases.length === 0) return null

  const packages = await NpmTool.getPackages(root)
  const rootName = packages.rootPackage.packageJson.name
  const hasRootRelease = releases.some((release) => release.name === rootName)
  const hasPackageRelease = releases.some((release) => release.name !== rootName)
  const packagesByName = new Map(
    [packages.rootPackage, ...packages.packages].map((pkg) => [pkg.packageJson.name, pkg]),
  )
  await runChangeset(["version"], root)
  const entries = []
  for (const { name, newVersion } of releases) {
    const changelog = await readFile(join(packagesByName.get(name).dir, "CHANGELOG.md"), "utf8")
    const entry = changelog.split(`\n## ${newVersion}\n`)[1]?.split("\n## ")[0].trim()
    if (!entry) throw new Error(`${name} must have a nonempty changelog entry.`)
    entries.push(`## ${name}@${newVersion}`, "", entry, "")
  }
  const introduction = hasRootRelease
    ? "This PR updates the repository version. Merge it to publish the repository tag, container, and GitHub release, then deploy that tag."
    : "This PR updates the diagram-viewer npm package version. Merge it to publish the package to npm."

  return [
    introduction,
    ...(hasRootRelease && hasPackageRelease
      ? ["It also updates the diagram-viewer npm package version for publication to npm."]
      : []),
    "",
    "# Releases",
    "",
    ...entries,
  ].join("\n")
}

if (import.meta.main) {
  try {
    const body = await prepareRelease()
    if (process.env.GITHUB_OUTPUT) {
      const outputs = [`has-releases=${body !== null}`]
      if (body !== null) {
        const bodyPath = join(process.env.RUNNER_TEMP || tmpdir(), "morsel-release-pr.md")
        await writeFile(bodyPath, body)
        outputs.push(`body-path=${bodyPath}`)
      }
      await appendFile(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`)
    }
    console.log(
      body === null ? "No repository release to prepare." : "Prepared repository version PR.",
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
