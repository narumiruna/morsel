import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./deploy.sh", import.meta.url))
const commands = [
  ["stop", "morsel"],
  ["up", "--detach", "--wait", "--wait-timeout", "120", "postgres"],
  ["run", "--rm", "--no-deps", "migrate"],
  ["up", "--detach", "--no-deps", "--wait", "--wait-timeout", "120", "morsel"],
]

async function run(failedCommand) {
  const directory = await mkdtemp(join(tmpdir(), "morsel-deploy-test-"))
  try {
    const log = join(directory, "commands.jsonl")
    const docker = join(directory, "docker")
    await writeFile(
      docker,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
const args = process.argv.slice(2)
appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify(args) + "\\n")
if (JSON.stringify(args.slice(3)) === process.env.DEPLOY_TEST_FAIL) process.exit(1)
`,
    )
    await chmod(docker, 0o700)
    const result = spawnSync("bash", [script, "--project-name", "rehearsal"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        MORSEL_IMAGE: "morsel:deployment-fixture",
        DEPLOY_TEST_LOG: log,
        DEPLOY_TEST_FAIL: JSON.stringify(failedCommand),
      },
    })
    assert.equal(result.error, undefined)
    const called = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    for (const args of called) {
      assert.deepEqual(args.slice(0, 3), ["compose", "--project-name", "rehearsal"])
    }
    return { status: result.status, called: called.map((args) => args.slice(3)) }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("deployment stops the old service before migration and starts only the replacement", async () => {
  const result = await run(null)
  assert.equal(result.status, 0)
  assert.deepEqual(result.called, commands)
})

for (const [index, command] of commands.entries()) {
  test(`deployment failure at step ${index + 1} stops service and never starts an old image`, async () => {
    const result = await run(command)
    assert.notEqual(result.status, 0)
    assert.deepEqual(result.called, [...commands.slice(0, index + 1), ["stop", "morsel"]])
  })
}
