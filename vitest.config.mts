import { defineConfig, mergeConfig } from "vitest/config"
import viewerConfig from "./packages/viewer/vite.config.ts"

export default mergeConfig(viewerConfig, defineConfig({ root: "packages/viewer" }))
