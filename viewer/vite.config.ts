import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv, type Plugin } from "vite"

function securityMeta(apiOrigin: string): Plugin {
  const escapedOrigin = apiOrigin.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
  return {
    name: "morsel-security-meta",
    transformIndexHtml(html) {
      return html.replace(
        "<!-- morsel-security-meta -->",
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' https: data:; connect-src 'self' ${escapedOrigin}">\n    <meta name="referrer" content="no-referrer">`,
      )
    },
  }
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_")
  const apiBaseUrl = environment.VITE_API_BASE_URL || "http://127.0.0.1:8080"
  const apiUrl = new URL(apiBaseUrl)
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new Error("VITE_API_BASE_URL must not contain credentials, query, or fragment")
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(apiUrl.hostname)
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && loopback)) {
    throw new Error("VITE_API_BASE_URL must use HTTPS (HTTP is allowed only for local development)")
  }
  return {
    base: environment.VITE_BASE_PATH || "/",
    plugins: [react(), securityMeta(apiUrl.origin)],
    define: {
      __MORSEL_API_BASE_URL__: JSON.stringify(apiBaseUrl.replace(/\/$/, "")),
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: true,
      clearMocks: true,
      exclude: ["e2e/**", "node_modules/**", "dist/**"],
    },
  }
})
