import { afterAll, describe, expect, test } from "bun:test"
import { dirFuzz } from "@/scanners/dir-fuzzer"
import { analyzeJs } from "@/scanners/js-analyzer"
import { scanPorts } from "@/scanners/port-scanner"
import { probeServices } from "@/scanners/service-prober"
import { createServer as createTcpServer } from "node:net"

const servers: Bun.Server<unknown>[] = []
afterAll(() => {
  for (const server of servers) server.stop(true)
})

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  servers.push(server)
  return server
}

describe("dir-fuzz boundary callback", () => {
  test("every word and the baseline go through allowUrl", async () => {
    const hits: string[] = []
    const server = serve((request) => {
      const path = new URL(request.url).pathname
      hits.push(path)
      if (path === "/allowed") return new Response("FOUND", { status: 200 })
      return new Response("not found", { status: 404 })
    })
    const base = `http://127.0.0.1:${server.port}`
    const result = await dirFuzz(base, {
      wordlist: ["allowed", "blocked", "secret"],
      allowUrl: (url) => new URL(url).pathname === "/allowed",
    })
    expect(hits).toEqual(["/allowed"])
    expect(result.found.map((item) => item.path)).toEqual(["/allowed"])
    expect(result.testedCount).toBe(1)
    // baseline + blocked + secret
    expect(result.blockedCount).toBe(3)
  })

  test("without a callback every word is fetched", async () => {
    const hits: string[] = []
    const server = serve((request) => {
      const path = new URL(request.url).pathname
      hits.push(path)
      if (path === "/admin" || path === "/api") return new Response("FOUND", { status: 200 })
      return new Response("nope", { status: 404 })
    })
    const base = `http://127.0.0.1:${server.port}`
    const result = await dirFuzz(base, { wordlist: ["admin", "api", "missing"], concurrency: 1 })
    expect(result.found.map((item) => item.path).sort()).toEqual(["/admin", "/api"])
    expect(result.testedCount).toBe(3)
    expect(result.blockedCount).toBe(0)
    expect(hits.some((path) => path.startsWith("/axiomsec_404_check_"))).toBe(true)
  })

  test("a redirect is reported but not followed", async () => {
    const hits: string[] = []
    const server = serve((request) => {
      const path = new URL(request.url).pathname
      hits.push(path)
      if (path === "/old") return new Response(null, { status: 302, headers: { Location: "/new" } })
      if (path === "/new") return new Response("LANDED", { status: 200 })
      return new Response("not found", { status: 404 })
    })
    const base = `http://127.0.0.1:${server.port}`
    const result = await dirFuzz(base, { wordlist: ["old"], concurrency: 1 })
    const found = result.found.find((item) => item.path === "/old")
    expect(found?.status).toBe(302)
    expect(found?.redirect).toBe("/new")
    expect(hits).not.toContain("/new")
  })
})

describe("JS analyzer", () => {
  test("extracts endpoints, secrets, SPA routes and chatbot indicators from inline and external code", async () => {
    const google = "AIza" + "A".repeat(35)
    const server = serve((request) => {
      const path = new URL(request.url).pathname
      if (path === "/app.js") {
        return new Response(
          [
            'fetch("/v2/data")',
            'const api_key = "' + google + '"',
            'const route = { path: "/dashboard" }',
            'const widget = "intercom"',
          ].join("\n"),
          { headers: { "content-type": "application/javascript" } },
        )
      }
      return new Response(
        [
          "<html><body>",
          '<script>const users = "/api/users";</script>',
          '<script src="/app.js"></script>',
          "</body></html>",
        ].join("\n"),
        { headers: { "content-type": "text/html" } },
      )
    })
    const base = `http://127.0.0.1:${server.port}/`
    const result = await analyzeJs(base, { maxFiles: 5, timeout: 5_000 })
    expect(result.endpoints).toContain("/api/users")
    expect(result.endpoints).toContain("/v2/data")
    expect(result.secrets.some((secret) => secret.type === "Google API Key" && secret.value === google)).toBe(true)
    expect(result.spaRoutes).toContain("/dashboard")
    expect(result.chatbotIndicators).toContain("intercom")
    expect(result.jsFiles).toHaveLength(1)
    expect(result.jsFiles[0]).toContain("/app.js")
  })

  test("an external script outside the allowed path is never fetched", async () => {
    const hits: string[] = []
    const server = serve((request) => {
      const path = new URL(request.url).pathname
      hits.push(path)
      if (path === "/app.js") {
        return new Response('const k = "AIza' + "B".repeat(35) + '"', {
          headers: { "content-type": "application/javascript" },
        })
      }
      return new Response('<html><script src="/app.js"></script><script>const u="/api/inline";</script></html>', {
        headers: { "content-type": "text/html" },
      })
    })
    const base = `http://127.0.0.1:${server.port}/`
    const result = await analyzeJs(base, {
      maxFiles: 5,
      timeout: 5_000,
      allowUrl: (url) => new URL(url).pathname === "/",
    })
    expect(hits).toEqual(["/"])
    expect(result.endpoints).toContain("/api/inline")
    expect(result.secrets).toEqual([])
  })

  test("a redirect target outside the boundary is refused", async () => {
    const server = serve((request) => {
      const path = new URL(request.url).pathname
      if (path === "/") {
        return new Response(null, { status: 302, headers: { Location: "/login" } })
      }
      return new Response("<html>LOGIN</html>", { headers: { "content-type": "text/html" } })
    })
    const base = `http://127.0.0.1:${server.port}/`
    await expect(
      analyzeJs(base, { timeout: 5_000, allowUrl: (url) => new URL(url).pathname === "/" }),
    ).rejects.toThrow(/not allowed/)
  })
})

describe("port and service scanners", () => {
  test("a TCP listener that sends no banner is still reported open", async () => {
    const silent = createTcpServer((socket) => socket.on("error", () => {}))
    try {
      await new Promise<void>((resolve, reject) => {
        silent.once("error", reject)
        silent.listen(0, "127.0.0.1", () => resolve())
      })
      const address = silent.address()
      if (!address || typeof address === "string") throw new Error("expected a TCP address")
      const result = await scanPorts("127.0.0.1", { ports: [address.port], concurrency: 1, timeout: 250 })
      expect(result.openPorts.map((item) => item.port)).toEqual([address.port])
      expect(result.openPorts[0]?.open).toBe(true)
      expect(result.closedCount).toBe(0)
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })

  test("service mode sends an active probe to an HTTP listener", async () => {
    const server = serve(() => new Response("SERVICE-OK", { headers: { "content-type": "text/plain" } }))
    const port = server.port
    if (port === undefined) throw new Error("expected a listening port")
    const result = await probeServices("127.0.0.1", [port], { concurrency: 1, timeout: 1000 })
    expect(result.services).toHaveLength(1)
    expect(result.services[0]?.port).toBe(port)
    expect(result.services[0]?.protocol).toBe("http")
    expect(result.services[0]?.banner).toContain("SERVICE-OK")
  })
})
