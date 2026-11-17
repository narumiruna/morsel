import { spawnSync } from "node:child_process"
import { copyFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const root = new URL("./", import.meta.url)
await rm(new URL("dist/", root), { recursive: true, force: true })
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json"))),
    "-p",
    "tsconfig.json",
  ],
  { cwd: fileURLToPath(root), stdio: "inherit" },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
await copyFile(new URL("src/styles.css", root), new URL("dist/styles.css", root))
await copyFile(new URL("src/styles.css.d.ts", root), new URL("dist/styles.css.d.ts", root))
