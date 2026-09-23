import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "client",
    environment: "node",
    include: ["test/**/*.test.mjs"],
    globalSetup: "./test/build.mjs",
  },
})
