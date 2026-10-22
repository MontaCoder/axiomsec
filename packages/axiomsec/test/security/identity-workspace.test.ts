import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { binaryPath, ledger, readDb, run, workspace, type Workspace } from "../support/harness"

const BIN = binaryPath()

async function createOperation(ws: Workspace, target = "http://127.0.0.1:18080") {
  const result = await run(ws, ["operation", "new", "Identity Workspace", "--kind", "pentest", "--target", target])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1]!
}

async function tool(ws: Workspace, id: string, params: Record<string, unknown>, skip = true) {
  const args = ["debug", "agent", "security", "--tool", id, "--params", JSON.stringify(params)]
  if (skip) args.push("--dangerously-skip-permissions")
  const result = await run(ws, args)
  const json = (() => {
    try {
      return JSON.parse(result.stdout) as { result: { title: string; output: string; metadata: Record<string, any> } }
    } catch {
      return undefined
    }
  })()
  return { ...result, json }
}

describe.skipIf(!BIN)("identity secret containment and use", () => {
  test(
    "an identity is permissioned, redacted in persistence, and applied to HTTP requests",
    async () => {
      const ws = await workspace("identity-canary")
      let authorization: string | undefined
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          authorization = request.headers.get("authorization") ?? undefined
          return new Response("IDENTITY-SEEN")
        },
      })
      try {
        const slug = await createOperation(ws, `http://127.0.0.1:${server.port}`)
        const canary = "IDENTITY-CANARY-7e1b"
        const identity = JSON.stringify({ headers: { Authorization: `Bearer ${canary}` } })

        const denied = await tool(ws, "identity", { action: "add", key: "operator", value: identity }, false)
        expect(denied.code).toBe(1)
        expect(denied.stderr).toContain("permission 'identity' resolves to ask")

        const added = await tool(ws, "identity", { action: "add", key: "operator", value: identity })
        expect(added.code).toBe(0)
        expect(added.json?.result.metadata).toMatchObject({ mode: "headers", key: "operator" })
        expect(added.json?.result.output).not.toContain(canary)

        const used = await tool(ws, "identity", { action: "use", key: "operator" })
        expect(used.code).toBe(0)
        const status = await tool(ws, "identity", { action: "status" })
        expect(status.json?.result.output).toContain("Active identity: operator")
        expect(status.json?.result.output).toContain("Authorization")

        const events = ledger(ws, slug)
        expect(JSON.stringify(events)).not.toContain(canary)
        const db = readDb(ws)
        try {
          const parts = db.query("SELECT data FROM part").all() as Array<{ data: string }>
          expect(parts.map((row) => row.data).join("\n")).not.toContain(canary)
        } finally {
          db.close()
        }

        const request = await tool(ws, "http_request", {
          url: `http://127.0.0.1:${server.port}/identity`,
          method: "GET",
        })
        expect(request.code).toBe(0)
        expect(authorization).toBe(`Bearer ${canary}`)

        const cleared = await tool(ws, "identity", { action: "clear" })
        expect(cleared.code).toBe(0)
        const inactive = await tool(ws, "identity", { action: "status" })
        expect(inactive.json?.result.output).toContain("No active identity")
        expect(await readFile(join(ws.env.XDG_CONFIG_HOME, "axiomsec", "vault.json"), "utf8")).toContain(canary)
      } finally {
        server.stop(true)
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("workspace snapshot and query", () => {
  test(
    "snapshot, query and timeline reflect the observed surface",
    async () => {
      const ws = await workspace("workspace-query")
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname
          if (path === "/local") return new Response("<html><body>LOCAL</body></html>", { headers: { "content-type": "text/html" } })
          return new Response('<html><body><a href="/local">local</a></body></html>', {
            headers: { "content-type": "text/html" },
          })
        },
      })
      try {
        const slug = await createOperation(ws, `http://127.0.0.1:${server.port}`)
        const crawled = await tool(ws, "scanner", {
          mode: "crawl",
          target: `http://127.0.0.1:${server.port}/`,
          options: { maxUrls: 5, maxDepth: 2, timeout: 5_000 },
        })
        expect(crawled.code).toBe(0)

        const snapshot = await tool(ws, "workspace", { action: "snapshot" })
        expect(snapshot.code).toBe(0)
        expect(snapshot.json?.result.output).toContain("Operation: Identity Workspace")
        expect(snapshot.json?.result.output).toContain("routes=2")
        expect(snapshot.json?.result.metadata).toMatchObject({ action: "snapshot" })
        expect(snapshot.json?.result.output).toContain("/local")

        const routes = await tool(ws, "workspace", { action: "query", query: "routes" })
        expect(routes.code).toBe(0)
        const payload = JSON.parse(routes.json?.result.output ?? "{}")
        expect(payload.query).toBe("routes")
        expect(payload.count).toBeGreaterThan(0)
        expect(JSON.stringify(payload.rows)).toContain("/local")

        const timeline = await tool(ws, "workspace", { action: "timeline" })
        expect(timeline.code).toBe(0)
        expect(timeline.json?.result.metadata.count).toBeGreaterThan(0)
        expect(timeline.json?.result.output).toContain("scanner")

        const graph = await tool(ws, "workspace", { action: "graph_digest" })
        expect(graph.code).toBe(0)
        expect(graph.json?.result.metadata.facts).toBeGreaterThan(0)
        expect(graph.json?.result.metadata.relations).toBeGreaterThanOrEqual(0)
        expect(graph.json?.result.output).toContain(slug)
      } finally {
        server.stop(true)
        await ws.cleanup()
      }
    },
    120_000,
  )
})
