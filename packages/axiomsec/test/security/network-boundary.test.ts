import { afterAll, describe, expect, test } from "bun:test"
import { binaryPath, ledger, run, workspace, type Workspace } from "../support/harness"
import * as net from "node:net"
import { createSocket } from "node:dgram"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const BIN = binaryPath()

async function createStrictOperation(ws: Workspace, target: string) {
  const created = await run(ws, ["operation", "new", "Boundary", "--kind", "pentest", "--target", target])
  expect(created.code).toBe(0)
  const slug = /created ([a-z0-9-]+) \[/.exec(created.stdout + created.stderr)?.[1]
  expect(slug).toBeTruthy()
  const strict = await run(ws, [
    "debug",
    "agent",
    "security",
    "--tool",
    "scope",
    "--params",
    JSON.stringify({ action: "set", level: "strict" }),
    "--dangerously-skip-permissions",
  ])
  expect(strict.code).toBe(0)
  return slug!
}

async function tool(
  ws: Workspace,
  id: string,
  params: Record<string, unknown>,
  extraEnv?: Record<string, string>,
) {
  const result = await run(
    ws,
    ["debug", "agent", "security", "--tool", id, "--params", JSON.stringify(params), "--dangerously-skip-permissions"],
    extraEnv,
  )
  const parsed = (() => {
    try {
      return JSON.parse(result.stdout) as { result?: { output?: string; metadata?: Record<string, any> } }
    } catch {
      return undefined
    }
  })()
  return { ...result, json: parsed }
}

function chromiumPath(): string | undefined {
  if (process.env.AXIOMSEC_CHROMIUM_PATH && existsSync(process.env.AXIOMSEC_CHROMIUM_PATH)) {
    return process.env.AXIOMSEC_CHROMIUM_PATH
  }
  const candidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : undefined,
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ].filter((item): item is string => Boolean(item))
  const executables = [
    join("chrome-win64", "chrome.exe"),
    join("chrome-win", "chrome.exe"),
    join("chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    join("chrome-linux", "chrome"),
    join("chrome-mac", "Chromium.app"),
  ]
  for (const root of candidates) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium")) continue
      for (const executable of executables) {
        const path = join(root, entry, executable)
        if (existsSync(path)) return path
      }
    }
  }
  return undefined
}

const CHROMIUM = chromiumPath()

const servers: Bun.Server<unknown>[] = []

afterAll(() => {
  for (const server of servers) server.stop(true)
})

function serve(hostname: string, handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname, port: 0, async fetch(request) {
    return await handler(request)
  } })
  servers.push(server)
  return server
}

describe.skipIf(!BIN)("redirect and subresource scope enforcement (RISK-SCOPE-05)", () => {
  test(
    "an in-scope request that redirects to an out-of-scope host is stopped before the second request",
    async () => {
      const ws = await workspace("redirect-boundary")
      const hits = { inside: 0, outside: 0 }
      let outsidePort = 0
      try {
        const outside = serve("127.0.0.2", () => {
          hits.outside += 1
          return new Response("OUT-OF-SCOPE-HIT")
        })
        outsidePort = outside.port ?? 0
        const inside = serve("127.0.0.1", () => {
          hits.inside += 1
          return new Response(null, {
            status: 302,
            headers: { Location: `http://127.0.0.2:${outsidePort}/landed` },
          })
        })
        await createStrictOperation(ws, `http://127.0.0.1:${inside.port}`)

        const result = await tool(ws, "http_request", {
          url: `http://127.0.0.1:${inside.port}/start`,
          method: "GET",
        })
        expect(result.code).toBe(1)
        expect(result.stdout + result.stderr).toContain("out of scope")
        expect(hits.inside).toBe(1)
        expect(hits.outside).toBe(0)
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "a same-origin redirect is followed and recorded",
    async () => {
      const ws = await workspace("redirect-same")
      try {
        const server = serve("127.0.0.1", (request) => {
          const url = new URL(request.url)
          if (url.pathname === "/start") {
            return new Response(null, { status: 302, headers: { Location: "/landed" } })
          }
          return new Response("SAME-ORIGIN-LANDED", { headers: { "content-type": "text/plain" } })
        })
        await createStrictOperation(ws, `http://127.0.0.1:${server.port}`)
        const result = await tool(ws, "http_request", {
          url: `http://127.0.0.1:${server.port}/start`,
          method: "GET",
        })
        expect(result.code).toBe(0)
        expect(result.json?.result?.output).toContain("HTTP 200")
        expect(result.json?.result?.output).toContain("SAME-ORIGIN-LANDED")
        expect(result.json?.result?.output).toContain("Final URL")
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "scanner crawl never requests a discovered out-of-scope host",
    async () => {
      const ws = await workspace("crawl-boundary")
      const hits = { inside: 0, outside: 0 }
      try {
        const outside = serve("127.0.0.2", () => {
          hits.outside += 1
          return new Response("OUT-OF-SCOPE-CRAWL")
        })
        const inside = serve("127.0.0.1", (request) => {
          hits.inside += 1
          const url = new URL(request.url)
          if (url.pathname === "/local") return new Response("<html><body>LOCAL-PAGE</body></html>", { headers: { "content-type": "text/html" } })
          return new Response(
            `<html><body><a href="/local">local</a><a href="http://127.0.0.2:${outside.port}/upstream">upoutside</a></body></html>`,
            { headers: { "content-type": "text/html" } },
          )
        })
        await createStrictOperation(ws, `http://127.0.0.1:${inside.port}`)
        const result = await tool(ws, "scanner", {
          mode: "crawl",
          target: `http://127.0.0.1:${inside.port}/`,
          options: { maxUrls: 10, maxDepth: 2, timeout: 5_000 },
        })
        expect(result.code).toBe(0)
        expect(result.json?.result?.output).toContain("/local")
        expect(result.json?.result?.output).not.toContain("127.0.0.2")
        expect(hits.outside).toBe(0)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("appsec probe per-route boundary (RISK-SCOPE-10)", () => {
  test(
    "probe paths outside the path-scoped boundary are skipped, not fetched",
    async () => {
      const ws = await workspace("appsec-path-scope")
      const hits: string[] = []
      try {
        const server = serve("127.0.0.1", (request) => {
          const url = new URL(request.url)
          hits.push(url.pathname)
          if (url.pathname === "/login") {
            return new Response(
              '<html><body><form method="POST" action="/login"><input name="username"><input type="password" name="password"></form></body></html>',
              { headers: { "content-type": "text/html" } },
            )
          }
          if (url.pathname === "/allowed/search") {
            return new Response("<html><body>search results</body></html>", {
              headers: { "content-type": "text/html" },
            })
          }
          return new Response(
            '<html><body><form method="GET" action="/allowed/search"><input name="q"></form><a href="/login">login</a></body></html>',
            { headers: { "content-type": "text/html" } },
          )
        })
        const base = `http://127.0.0.1:${server.port}`
        const slug = await createStrictOperation(ws, `${base}/allowed`)
        // The scanner seeds the observed surface from real same-origin routes.
        const crawled = await tool(ws, "scanner", {
          mode: "crawl",
          target: `${base}/allowed`,
          options: { maxUrls: 10, maxDepth: 2, timeout: 5_000 },
        })
        expect(crawled.code).toBe(0)
        expect(hits).toContain("/login")

        // Narrow the canonical boundary to the target path only.
        const db = new (await import("bun:sqlite")).Database(ws.env.AXIOMSEC_DB)
        try {
          const boundary = {
            default: "ask",
            in_scope: [`${base}/allowed`],
            out_of_scope: [],
            opsec: "strict",
          }
          db.query("UPDATE cyber_fact SET value_json = ? WHERE operation_slug = ? AND fact_name = 'scope_policy'").run(
            JSON.stringify(boundary),
            slug,
          )
        } finally {
          db.close()
        }

        hits.length = 0
        const probed = await tool(ws, "appsec_probe", {
          target: `${base}/allowed`,
          checks: ["sqli_search", "xss_search", "broken_auth_jwt", "weak_cors"],
          timeout: 5_000,
        })
        expect(probed.code).toBe(0)
        expect(hits).toContain("/allowed")
        expect(hits).not.toContain("/login")
        expect(probed.json?.result?.output ?? "").toContain("path outside operation boundary")
      } finally {
        await ws.cleanup()
      }
    },
    180_000,
  )
})

describe.skipIf(!BIN)("webfetch guard and content conversion", () => {
  test(
    "webfetch converts a page and blocks an out-of-scope redirect",
    async () => {
      const ws = await workspace("webfetch-boundary")
      const hits = { inside: 0, outside: 0 }
      try {
        const outside = serve("127.0.0.2", () => {
          hits.outside += 1
          return new Response("OUTSIDE")
        })
        const inside = serve("127.0.0.1", (request) => {
          hits.inside += 1
          const path = new URL(request.url).pathname
          if (path === "/redirect") {
            return new Response(null, { status: 302, headers: { Location: `http://127.0.0.2:${outside.port}/landed` } })
          }
          return new Response("<html><head><title>Fixture</title></head><body><h1>Hello</h1><p>WEBFETCH-BODY</p></body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          })
        })
        await createStrictOperation(ws, `http://127.0.0.1:${inside.port}`)

        const fetched = await tool(ws, "webfetch", {
          url: `http://127.0.0.1:${inside.port}/page`,
          format: "markdown",
        })
        expect(fetched.code).toBe(0)
        expect(fetched.json?.result?.output ?? "").toContain("WEBFETCH-BODY")
        expect(fetched.json?.result?.output ?? "").toContain("Hello")

        const redirected = await tool(ws, "webfetch", {
          url: `http://127.0.0.1:${inside.port}/redirect`,
          format: "text",
        })
        expect(redirected.code).toBe(1)
        expect(redirected.stdout + redirected.stderr).toContain("out of scope")
        expect(hits.outside).toBe(0)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN || !CHROMIUM)("browser boundary enforcement (RISK-SCOPE-01/06)", () => {
  test(
    "an in-scope page loads while its out-of-scope subresource is blocked, and an explicit out-of-scope URL is denied",
    async () => {
      const ws = await workspace("browser-boundary")
      const hits = { inside: 0, outside: 0, sockets: 0 }
      try {
        const outside = Bun.serve({
          hostname: "127.0.0.2",
          port: 0,
          fetch(request, server) {
            if (server.upgrade(request)) return undefined
            hits.outside += 1
            return new Response("TRACKER-HIT", { headers: { "content-type": "text/plain" } })
          },
          websocket: {
            open() {
              hits.sockets += 1
            },
            message() {},
          },
        })
        servers.push(outside as unknown as Bun.Server<unknown>)
        const inside = serve("127.0.0.1", () => {
          hits.inside += 1
          return new Response(
            `<html><head><title>Browser Fixture</title></head><body><h1>IN-SCOPE-PAGE</h1>` +
              `<img src="http://127.0.0.2:${outside.port}/tracker" />` +
              `<script>try { new WebSocket("ws://127.0.0.2:${outside.port}/socket") } catch (e) {}</script>` +
              `</body></html>`,
            { headers: { "content-type": "text/html" } },
          )
        })
        await createStrictOperation(ws, `http://127.0.0.1:${inside.port}`)

        const browserEnv = { AXIOMSEC_CHROMIUM_PATH: CHROMIUM! }
        const allowed = await tool(
          ws,
          "browser",
          {
            action: "navigate",
            url: `http://127.0.0.1:${inside.port}/page`,
            timeout: 20_000,
          },
          browserEnv,
        )
        expect(allowed.code).toBe(0)
        expect(allowed.json?.result?.output ?? "").toContain("IN-SCOPE-PAGE")
        expect(hits.inside).toBeGreaterThan(0)
        // Give the page a moment to attempt both subresources.
        await Bun.sleep(500)
        expect(hits.outside).toBe(0)
        expect(hits.sockets).toBe(0)

        const denied = await tool(
          ws,
          "browser",
          {
            action: "navigate",
            url: `http://127.0.0.2:${outside.port}/`,
            timeout: 20_000,
          },
          browserEnv,
        )
        expect(denied.code).toBe(1)
        expect(denied.stdout + denied.stderr).toContain("out of scope")
        expect(hits.outside).toBe(0)
      } finally {
        await ws.cleanup()
      }
    },
    180_000,
  )

  test(
    "a WebRTC STUN request cannot leave the boundary (RISK-SCOPE-11)",
    async () => {
      const ws = await workspace("browser-webrtc")
      const udp = createSocket("udp4")
      let stunHits = 0
      try {
        await new Promise<void>((resolve, reject) => {
          udp.once("error", reject)
          udp.bind(0, "127.0.0.2", () => resolve())
        })
        udp.on("message", () => {
          stunHits += 1
        })
        const stunPort = udp.address().port
        const inside = serve(
          "127.0.0.1",
          () =>
            new Response(
              `<html><body>WEBRTC-PAGE<script>
const pc = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.2:${stunPort}'}]});
pc.createDataChannel('probe');
pc.createOffer().then((offer) => pc.setLocalDescription(offer));
</script></body></html>`,
              { headers: { "content-type": "text/html" } },
            ),
        )
        await createStrictOperation(ws, `http://127.0.0.1:${inside.port}`)
        const result = await tool(
          ws,
          "browser",
          { action: "navigate", url: `http://127.0.0.1:${inside.port}/webrtc`, timeout: 20_000 },
          { AXIOMSEC_CHROMIUM_PATH: CHROMIUM! },
        )
        expect(result.code).toBe(0)
        await Bun.sleep(1_500)
        expect(stunHits).toBe(0)
      } finally {
        udp.close()
        await ws.cleanup()
      }
    },
    180_000,
  )

  test(
    "a service worker fetch cannot leave the boundary",
    async () => {
      const ws = await workspace("browser-sw")
      let outsideHits = 0
      let insideHits = 0
      try {
        const outside = serve("127.0.0.2", () => {
          outsideHits += 1
          return new Response("SW-TRACKER")
        })
        const inside = serve("127.0.0.1", (request) => {
          const path = new URL(request.url).pathname
          if (path === "/sw.js") {
            return new Response(
              `self.addEventListener('install', (event) => {
                event.waitUntil(Promise.all([
                  fetch('/inside').catch(() => undefined),
                  fetch('http://127.0.0.2:${outside.port}/tracker').catch(() => self.skipWaiting()),
                ]))
              })`,
              { headers: { "content-type": "application/javascript" } },
            )
          }
          if (path === "/inside") {
            insideHits += 1
            return new Response("SW-INSIDE")
          }
          return new Response(
            `<html><body>SW-PAGE<script>navigator.serviceWorker.register('/sw.js').catch(() => {})</script></body></html>`,
            { headers: { "content-type": "text/html" } },
          )
        })
        await createStrictOperation(ws, `http://127.0.0.1:${inside.port}`)
        const result = await tool(
          ws,
          "browser",
          { action: "navigate", url: `http://127.0.0.1:${inside.port}/sw`, timeout: 20_000 },
          { AXIOMSEC_CHROMIUM_PATH: CHROMIUM! },
        )
        expect(result.code).toBe(0)
        await Bun.sleep(1_500)
        expect(insideHits).toBeGreaterThan(0)
        expect(outsideHits).toBe(0)
      } finally {
        await ws.cleanup()
      }
    },
    180_000,
  )
})

describe.skipIf(!BIN)("scanner port and service modes", () => {
  test(
    "a loopback listener is found and identified",
    async () => {
      const ws = await workspace("scanner-ports")
      try {
        const server = serve("127.0.0.1", () => new Response("HTTP-SERVICE", { headers: { "content-type": "text/plain" } }))
        await createStrictOperation(ws, `http://127.0.0.1:${server.port}`)
        const ports = await tool(ws, "scanner", {
          mode: "ports",
          target: "127.0.0.1",
          options: { ports: [server.port, 1], concurrency: 2, timeout: 1_000 },
        })
        expect(ports.code).toBe(0)
        const portResult = JSON.parse(ports.json?.result?.output ?? "{}") as {
          openPorts?: Array<{ port: number }>
          closedCount?: number
        }
        expect(portResult.openPorts?.some((item) => item.port === server.port)).toBe(true)
        expect(portResult.closedCount).toBeGreaterThanOrEqual(1)

        const service = await tool(ws, "scanner", {
          mode: "service",
          target: "127.0.0.1",
          options: { ports: [server.port], concurrency: 1, timeout: 1_000 },
        })
        expect(service.code).toBe(0)
        const serviceResult = JSON.parse(service.json?.result?.output ?? "{}") as {
          services?: Array<{ port: number; service?: string }>
        }
        expect(serviceResult.services?.some((item) => item.port === server.port)).toBe(true)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("net boundary enforcement (RISK-SCOPE-01)", () => {
  test(
    "UDP send reaches an in-scope listener and returns its reply",
    async () => {
      const ws = await workspace("net-udp")
      const socket = await import("node:dgram")
      const server = socket.createSocket("udp4")
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.once("message", (message, remote) => {
            server.send(`PONG:${message.toString()}`, remote.port, remote.address)
          })
          server.bind(0, "127.0.0.1", () => resolve())
        })
        const port = server.address().port
        await createStrictOperation(ws, `http://127.0.0.1:${port}`)
        const result = await tool(ws, "net", {
          op: "udp_send",
          host: "127.0.0.1",
          port,
          payload: "PING",
          timeout_ms: 2_000,
        })
        expect(result.code).toBe(0)
        expect(result.json?.result?.output ?? "").toContain("PONG:PING")
      } finally {
        server.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "an in-scope banner grab reaches the listener and an out-of-scope host is denied before connect",
    async () => {
      const ws = await workspace("net-boundary")
      let server: net.Server | undefined
      try {
        const port = await new Promise<number>((resolve, reject) => {
          server = net.createServer((socket) => {
            socket.write("SSH-2.0-AXIOMSEC-CANARY\r\n")
            socket.end()
          })
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => {
            const address = server!.address()
            if (typeof address === "object" && address) resolve(address.port)
            else reject(new Error("no address"))
          })
        })
        const slug = await createStrictOperation(ws, `http://127.0.0.1:${port}`)

        const allowed = await tool(ws, "net", {
          op: "banner_grab",
          host: "127.0.0.1",
          port,
          timeout_ms: 2_000,
        })
        expect(allowed.code).toBe(0)
        expect(allowed.json?.result?.output).toContain("AXIOMSEC-CANARY")

        const denied = await tool(ws, "net", {
          op: "tcp_send",
          host: "127.0.0.2",
          port: 9,
          timeout_ms: 500,
        })
        expect(denied.code).toBe(1)
        expect(denied.stdout + denied.stderr).toContain("out of scope")

        // Both calls are audited; the denied one must still have a tool.error.
        const events = ledger(ws, slug)
        expect(events.some((event) => event.kind === "tool.completed" && event.source === "net")).toBe(true)
        expect(events.some((event) => event.kind === "tool.error" && event.source === "net")).toBe(true)
      } finally {
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
        await ws.cleanup()
      }
    },
    90_000,
  )
})
