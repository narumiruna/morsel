import { readFileSync } from "node:fs"
import { defineConfig, devices } from "@playwright/test"

const isWSL =
  Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) ||
  (process.platform === "linux" &&
    /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")))

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4175",
    launchOptions: { args: isWSL ? ["--ozone-platform=wayland"] : [] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "vite test/browser --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
