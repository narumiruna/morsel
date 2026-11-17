import { readFileSync } from "node:fs"
import { defineConfig, devices } from "@playwright/test"

const isWSL =
  Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) ||
  (process.platform === "linux" &&
    /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")))

const live = process.env.MORSEL_E2E_LIVE === "1"
const previewPort = process.env.MORSEL_E2E_PREVIEW_PORT ?? "4173"
const liveBaseURL = (process.env.MORSEL_E2E_API_BASE ?? "http://127.0.0.1:12647").replace(
  /\/+$/,
  "",
)

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: live ? `${liveBaseURL}/` : `http://127.0.0.1:${previewPort}/`,
    launchOptions: { args: isWSL ? ["--ozone-platform=wayland"] : [] },
    trace: "retain-on-failure",
  },
  webServer: live
    ? undefined
    : {
        command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${previewPort}`,
        url: `http://127.0.0.1:${previewPort}/`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
