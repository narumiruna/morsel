import { defineConfig, devices } from "@playwright/test"

const live = process.env.MORSEL_E2E_LIVE === "1"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: live ? "http://127.0.0.1:12647/" : "http://127.0.0.1:4173/",
    trace: "retain-on-failure",
  },
  webServer: live
    ? undefined
    : {
        command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4173",
        url: "http://127.0.0.1:4173/",
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
