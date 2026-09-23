import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")

export function setup() {
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  })
}
