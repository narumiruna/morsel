import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, open, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// Build only with the patched, pinned Go toolchain.
process.env.GOTOOLCHAIN = "go1.26.10"
const adminURL = process.env.MORSEL_TEST_DATABASE_URL
if (!adminURL) {
  console.error("MORSEL_TEST_DATABASE_URL is required (PostgreSQL role must have CREATEDB)")
  process.exit(1)
}

const directory = await mkdtemp(join(tmpdir(), "morsel-auth-browser-"))
const databaseName = `morsel_auth_e2e_${randomBytes(12).toString("hex")}`
const helper = join(directory, "test-auth")
const children = new Set()
let databaseAttempted = false
let cleanupPromise
let stopping = false

function run(
  command,
  args,
  { env = process.env, capture = false, quiet = false, cwd = root } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: [
        "ignore",
        capture ? "pipe" : quiet ? "ignore" : "inherit",
        quiet ? "ignore" : "inherit",
      ],
    })
    children.add(child)
    let output = ""
    child.stdout?.on("data", (chunk) => {
      output += chunk
    })
    child.once("error", () => {
      children.delete(child)
      reject(new Error(`Cannot start ${command}`))
    })
    child.once("exit", (code) => {
      children.delete(child)
      if (code === 0) resolve(output.trim())
      else reject(new Error(`${command} failed`))
    })
  })
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => {
    const kill = (signal) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // The process can exit between the status check and the signal.
      }
    }
    const timer = setTimeout(() => kill("SIGKILL"), 5_000)
    child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
    kill("SIGTERM")
  })
}

function cleanup() {
  cleanupPromise ??= (async () => {
    stopping = true
    await Promise.all([...children].map(stop))
    try {
      if (databaseAttempted) {
        await run(helper, ["database-drop", databaseName], { quiet: true })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })()
  return cleanupPromise
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    void cleanup().then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      () => {
        console.error("Disposable database cleanup failed")
        process.exit(1)
      },
    )
  })
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

try {
  console.log("Building viewer and authentication browser backend")
  await run("npm", ["run", "build", "--workspace", "@narumitw/morsel-viewer"])
  for (const name of ["server", "migrate", "account", "test-auth"]) {
    if (stopping) throw new Error("Test interrupted")
    await run("go", ["build", "-o", join(directory, name), `./cmd/${name}`], {
      cwd: join(root, "api"),
    })
  }
  databaseAttempted = true
  // Only this generated database can be created or dropped by the helper.
  const databaseURL = await run(helper, ["database-create", databaseName], {
    capture: true,
    quiet: true,
  })
  if (stopping) throw new Error("Test interrupted")
  const port = await availablePort()
  const origin = `http://localhost:${port}`
  const env = {
    ...process.env,
    MORSEL_DATABASE_URL: databaseURL,
    MORSEL_ENVIRONMENT: "development",
    MORSEL_ADDRESS: `127.0.0.1:${port}`,
    MORSEL_URL: origin,
    MORSEL_VIEWER_DIR: join(root, "packages/viewer/dist"),
    MORSEL_AUTH_TEST_ORIGIN: origin,
    MORSEL_AUTH_TEST_HELPER: helper,
    MORSEL_AUTH_TEST_OUTPUT: join(directory, "test-results"),
    MORSEL_AUTH_TEST_ACCOUNT: join(directory, "account"),
    MORSEL_AUTH_TEST_SERVER_LOG: join(directory, "server.log"),
  }
  delete env.MORSEL_API_KEY
  delete env.MORSEL_API_KEY_FILE
  await run(join(directory, "migrate"), [], { env, quiet: true })
  // Inspect actual backend logs for secret disclosure without printing them.
  // The private file is removed with the disposable database and test output.
  const log = await open(env.MORSEL_AUTH_TEST_SERVER_LOG, "wx", 0o600)
  let service
  try {
    service = spawn(join(directory, "server"), [], {
      cwd: root,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", log.fd, log.fd],
    })
  } finally {
    await log.close()
  }
  children.add(service)
  let serviceError = false
  service.once("error", () => {
    serviceError = true
    children.delete(service)
  })
  service.once("close", () => children.delete(service))
  let ready = false
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (stopping || serviceError || service.exitCode !== null)
      throw new Error("Backend did not start")
    try {
      const response = await fetch(`${origin}/v1/account`, { signal: AbortSignal.timeout(1_000) })
      const state = await response.json()
      if (response.ok && state.setup_required === true && state.authenticated === false) {
        ready = true
        break
      }
    } catch {
      // Retry only service readiness; never retry authentication or share writes.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error("Backend readiness failed")
  console.log("Running required authentication tests against isolated PostgreSQL")
  await run(
    "npx",
    ["--no-install", "playwright", "test", "--config", "playwright.auth.config.ts"],
    {
      env,
      cwd: join(root, "packages/viewer"),
    },
  )
} catch (error) {
  // Do not print database URLs, server logs, or authentication response bodies.
  console.error(error instanceof Error ? error.message : "Authentication browser test failed")
  process.exitCode = 1
} finally {
  try {
    await cleanup()
  } catch {
    console.error("Disposable database cleanup failed")
    process.exitCode = 1
  }
}
