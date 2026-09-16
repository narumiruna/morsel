import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const contentSecurityPolicy =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' https: data:; connect-src 'self'"

const apiProxy = {
  "/v1": "http://127.0.0.1:12647",
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: apiProxy,
  },
  preview: {
    headers: {
      "Content-Security-Policy": contentSecurityPolicy,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
    proxy: apiProxy,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    clearMocks: true,
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
})
