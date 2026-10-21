import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.MORSEL_AUTH_TEST_ORIGIN
if (!baseURL || !process.env.MORSEL_AUTH_TEST_HELPER || !process.env.MORSEL_AUTH_TEST_OUTPUT) {
  throw new Error("Run npm run test:auth:browser to start the isolated backend")
}

export default defineConfig({
  testDir: "./e2e-auth",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  forbidOnly: true,
  reporter: [["./e2e-auth/required-reporter.ts"]],
  // Authentication payloads and one-time keys must not enter test artifacts.
  preserveOutput: "never",
  outputDir: process.env.MORSEL_AUTH_TEST_OUTPUT,
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
