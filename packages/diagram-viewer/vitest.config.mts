import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "diagram-viewer",
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
    css: true,
    clearMocks: true,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx,mjs}"],
  },
})
