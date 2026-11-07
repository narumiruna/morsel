import { appendFile, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runChangeset } from "./changeset.mjs"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))

export async function prepareRelease(root = repositoryRoot) {
  const { releases } = JSON.parse(await runChangeset(["status"], root))
  if (releases.length === 0) return null

  await runChangeset(["version"], root)
  const { name, newVersion } = releases[0]
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8")
  const entry = changelog.split(`\n## ${newVersion}\n`)[1]?.split("\n## ")[0].trim()
  if (!entry) throw new Error("The repository release must have a nonempty changelog entry.")

  return [
    "This PR updates the repository version. Merge it to publish the repository tag, container, and GitHub release, then deploy that tag.",
    "",
    "# Releases",
    "",
    `## ${name}@${newVersion}`,
    "",
    entry,
    "",
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
