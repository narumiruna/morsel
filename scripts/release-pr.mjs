import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))

export async function releasePrBody(root = repositoryRoot) {
  const { name, version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8")
  const lines = []
  let collecting = false
  let fence
  for (const line of changelog.split(/\r?\n/)) {
    if (!fence && line.startsWith("## ")) {
      if (collecting) break
      collecting = line === `## ${version}`
      continue
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (!fence && marker) {
      fence = marker[1]
    } else if (fence && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) {
      fence = undefined
    }
    if (collecting) lines.push(line)
  }
  const notes = lines.join("\n").trim()
  if (!notes.replace(/^#{1,6}\s.*$/gm, "").trim()) {
    throw new Error(`CHANGELOG.md must contain release notes for ${version}.`)
  }

  return [
    "This PR prepares a repository release.",
    "",
    "Merging it publishes the repository tag, container image, and GitHub release. It then deploys that tag. No npm packages are published.",
    "",
    "# Releases",
    "",
    `## ${name}@${version}`,
    "",
    notes,
    "",
  ].join("\n")
}

if (import.meta.main) {
  try {
    process.stdout.write(await releasePrBody())
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
