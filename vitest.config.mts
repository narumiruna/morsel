import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      "./packages/client/vitest.config.mts",
      "./packages/diagram-viewer/vitest.config.mts",
      "./packages/viewer/vite.config.ts",
    ],
  },
})
