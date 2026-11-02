import { once } from "node:events"
import { createServer as createHTTPServer, request } from "node:http"
import type { AddressInfo } from "node:net"
import type { ProxyOptions } from "vite"
import { createServer as createViteServer, type ViteDevServer } from "vite"
import { expect, it } from "vitest"
import config from "./vite.config"

it("proxies only exact OAuth protocol and well-known routes while consent stays local", async () => {
  expect(config.server?.proxy).not.toHaveProperty("/oauth")
  expect(config.server?.proxy).not.toHaveProperty("/.well-known")
  const rules = Object.entries(config.server?.proxy ?? {}).filter(([key]) => key.startsWith("^"))
  expect(rules).toHaveLength(2)
  const seen: string[] = []
  const backend = createHTTPServer((incoming, response) => {
    seen.push(incoming.url ?? "")
    response.setHeader("Content-Type", "application/json")
    response.setHeader("Cache-Control", "no-store")
    response.end(JSON.stringify({ method: incoming.method, headers: incoming.headers }))
  })
  backend.listen(0, "127.0.0.1")
  await once(backend, "listening")
  let proxy: ViteDevServer | undefined
  try {
    const backendPort = (backend.address() as AddressInfo).port
    const proxyRules: Record<string, ProxyOptions> = {}
    for (const [key, value] of rules) {
      expect(value).toEqual({ target: "http://127.0.0.1:12647", changeOrigin: false })
      expect(config.preview?.proxy?.[key]).toEqual(value)
      if (typeof value === "string") throw new Error("OAuth needs explicit Host preservation")
      proxyRules[key] = { ...value, target: `http://127.0.0.1:${backendPort}` }
    }
    proxy = await createViteServer({
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: {
        host: "127.0.0.1",
        port: 0,
        watch: null,
        hmr: false,
        proxy: proxyRules,
      },
    })
    await proxy.listen()
    const address = proxy.httpServer?.address()
    if (!address || typeof address === "string") throw new Error("Proxy did not open a TCP port")
    const proxyPort = address.port
    const publicHost = `localhost:${proxyPort}`
    const send = (path: string, method: string) =>
      new Promise<{ status: number; body: string; cache?: string }>((resolve, reject) => {
        const outgoing = request(
          {
            hostname: "127.0.0.1",
            port: proxyPort,
            path,
            method,
            agent: false,
            headers: {
              Host: publicHost,
              Origin: `http://${publicHost}`,
              Accept: "text/html",
              "Content-Type": "application/x-www-form-urlencoded",
            },
          },
          (response) => {
            let body = ""
            response.setEncoding("utf8")
            response.on("data", (chunk) => {
              body += chunk
            })
            response.on("error", reject)
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body,
                cache: response.headers["cache-control"],
              }),
            )
          },
        )
        outgoing.on("error", reject)
        outgoing.end()
      })
    for (const [path, method] of [
      ["/oauth/authorize?client_id=fixture-only", "GET"],
      ["/oauth/token", "POST"],
      ["/oauth/register", "POST"],
      ["/oauth/revoke", "POST"],
      ["/.well-known/oauth-authorization-server", "GET"],
      ["/.well-known/oauth-protected-resource/mcp", "GET"],
    ]) {
      const result = await send(path ?? "", method ?? "GET")
      expect(result.status).toBe(200)
      expect(result.cache).toBe("no-store")
      expect(JSON.parse(result.body)).toMatchObject({
        method,
        headers: { host: publicHost, origin: `http://${publicHost}` },
      })
      expect(seen.at(-1)).toBe(path)
    }
    const forwardedCount = seen.length
    const consent = await send(`/oauth/consent?request=${"A".repeat(43)}`, "GET")
    expect(consent.status).toBe(200)
    expect(consent.body).toContain('<div id="root">')
    for (const path of [
      "/oauth/authorize/",
      "/oauth/authorize-extra",
      "/oauth/token/extra",
      "/oauth/unknown",
      "/.well-known/oauth-authorization-server/",
      "/.well-known/oauth-protected-resource/mcp/",
      "/.well-known/oauth-protected-resource/other",
      "/xwell-known/oauth-authorization-server",
    ])
      await send(path, "GET")
    expect(seen).toHaveLength(forwardedCount)
  } finally {
    await proxy?.close()
    await new Promise<void>((resolve, reject) =>
      backend.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

it("preserves the public MCP Host and protocol headers through the Vite proxy", async () => {
  const configured = config.server?.proxy?.["/mcp"]
  expect(configured).toEqual({ target: "http://127.0.0.1:12647", changeOrigin: false })
  expect(config.preview?.proxy?.["/mcp"]).toEqual(configured)
  if (!configured || typeof configured === "string")
    throw new Error("MCP needs explicit Host preservation")

  const backend = createHTTPServer((incoming, response) => {
    response.setHeader("Content-Type", "application/json")
    response.setHeader("Cache-Control", "no-store")
    response.end(
      JSON.stringify({ method: incoming.method, path: incoming.url, headers: incoming.headers }),
    )
  })
  backend.listen(0, "127.0.0.1")
  await once(backend, "listening")
  let proxy: ViteDevServer | undefined
  try {
    const backendPort = (backend.address() as AddressInfo).port
    proxy = await createViteServer({
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: {
        host: "127.0.0.1",
        port: 0,
        watch: null,
        hmr: false,
        proxy: { "/mcp": { ...configured, target: `http://127.0.0.1:${backendPort}` } },
      },
    })
    await proxy.listen()
    const address = proxy.httpServer?.address()
    if (!address || typeof address === "string") throw new Error("Proxy did not open a TCP port")
    const proxyPort = address.port
    const publicHost = `localhost:${proxyPort}`
    const forwarded = await new Promise<{
      status: number
      cache: string | undefined
      body: string
    }>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port: proxyPort,
          path: "/mcp",
          method: "POST",
          agent: false,
          headers: {
            Host: publicHost,
            Origin: `http://${publicHost}`,
            Authorization: "Bearer proxy-fixture-only",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
        },
        (response) => {
          let body = ""
          response.setEncoding("utf8")
          response.on("data", (chunk) => {
            body += chunk
          })
          response.on("error", reject)
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              cache: response.headers["cache-control"],
              body,
            }),
          )
        },
      )
      outgoing.on("error", reject)
      outgoing.end('{"jsonrpc":"2.0","id":1,"method":"ping"}')
    })
    expect(forwarded.status).toBe(200)
    expect(forwarded.cache).toBe("no-store")
    expect(JSON.parse(forwarded.body)).toMatchObject({
      method: "POST",
      path: "/mcp",
      headers: {
        host: publicHost,
        origin: `http://${publicHost}`,
        authorization: "Bearer proxy-fixture-only",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
    })
  } finally {
    await proxy?.close()
    await new Promise<void>((resolve, reject) =>
      backend.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
