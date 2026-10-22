import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { binaryPath, facts, ledger, run, workspace, type Workspace } from "../support/harness"

const BIN = binaryPath()

async function createOperation(ws: Workspace, target = "http://127.0.0.1:18080") {
  const result = await run(ws, ["operation", "new", "Share Play", "--kind", "pentest", "--target", target])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1]!
}

async function tool(ws: Workspace, id: string, params: Record<string, unknown>) {
  const result = await run(
    ws,
    ["debug", "agent", "security", "--tool", id, "--params", JSON.stringify(params), "--dangerously-skip-permissions"],
  )
  const json = (() => {
    try {
      return JSON.parse(result.stdout) as { result: { title: string; output: string; metadata: Record<string, any> } }
    } catch {
      return undefined
    }
  })()
  return { ...result, json }
}

async function extractTarball(tarball: string): Promise<{ text: string; files: string[] }> {
  const dir = join(tarball, "..")
  const name = tarball.split(/[\\/]/).pop()!
  const list = Bun.spawn(["tar", "-tzf", name], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const files = (await new Response(list.stdout).text()).split(/\r?\n/).filter(Boolean)
  await list.exited
  const dump = Bun.spawn(["tar", "-xOzf", name], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const text = await new Response(dump.stdout).text()
  await dump.exited
  return { text, files }
}

describe.skipIf(!BIN)("share redaction (RISK-SECRET-01)", () => {
  test(
    "a redacted share contains no canary and the unredacted control does",
    async () => {
      const ws = await workspace("share-canary")
      try {
        const slug = await createOperation(ws)
        const headerCanary = "SHARE-HEADER-CANARY"
        const jsonCanary = "SHARE-JSON-CANARY"
        const text = [
          `Authorization: Bearer ${headerCanary}`,
          `Cookie: session=${headerCanary}`,
          `api_key=${jsonCanary}`,
          JSON.stringify({ nested: { password: jsonCanary } }),
        ].join("\n")
        const added = await tool(ws, "evidence", { action: "add_text", text, label: "share-canary" })
        expect(added.code).toBe(0)

        const redacted = await tool(ws, "share", { action: "build", redact: true })
        expect(redacted.code).toBe(0)
        const tarball = redacted.json?.result.metadata.path as string
        expect(existsSync(tarball)).toBe(true)
        const bytes = await readFile(tarball)
        const digest = createHash("sha256").update(bytes).digest("hex")
        expect(redacted.json?.result.metadata.sha256).toBe(digest)

        const extracted = await extractTarball(tarball)
        expect(extracted.files.length).toBeGreaterThan(0)
        expect(extracted.text).not.toContain(headerCanary)
        expect(extracted.text).not.toContain(jsonCanary)

        const control = await tool(ws, "share", { action: "build", redact: false })
        expect(control.code).toBe(0)
        const controlTar = control.json?.result.metadata.path as string
        expect(controlTar).not.toBe(tarball)
        const raw = await extractTarball(controlTar)
        expect(raw.text).toContain(headerCanary)
        expect(raw.text).toContain(jsonCanary)

        // The staging tree is removed once the tarball exists.
        const opdir = join(ws.dir, ".axiomsec", "operation", slug)
        const entries = await readdir(opdir)
        expect(entries.some((entry) => entry.startsWith("share-") && !entry.endsWith(".tar.gz"))).toBe(false)
        expect(entries.some((entry) => entry.endsWith(".tar.gz"))).toBe(true)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("runbook workflows", () => {
  test(
    "list, status and run persist a runbook trace",
    async () => {
      const ws = await workspace("runbook-workflow")
      try {
        const slug = await createOperation(ws)
        const list = await tool(ws, "runbook", { action: "list" })
        expect(list.code).toBe(0)
        expect(list.json?.result.output).toContain("web-surface")
        expect(list.json?.result.output).toContain("network-surface")

        const status = await tool(ws, "runbook", { action: "status", id: "web-surface" })
        expect(status.code).toBe(0)
        expect(status.json?.result.metadata).toMatchObject({ id: "web-surface" })
        expect(status.json?.result.metadata.status).toMatch(/^(ready|degraded|unavailable)$/)

        const missing = await tool(ws, "runbook", { action: "status", id: "no-such-runbook" })
        expect(missing.code).toBe(0)
        expect(missing.json?.result.output).toContain("Unknown")

        const run = await tool(ws, "runbook", {
          action: "run",
          id: "network-surface",
          args: { target: "127.0.0.1" },
        })
        expect(run.code).toBe(0)
        expect(run.json?.result.output).toContain("# Play: Network Surface Map (network-surface)")

        const workflowPath = join(ws.dir, ".axiomsec", "operation", slug, "workflow", "runbook-network-surface.json")
        const workflow = JSON.parse(await readFile(workflowPath, "utf8"))
        expect(workflow.kind).toBe("runbook")
        expect(workflow.args).toEqual({ target: "127.0.0.1" })
        expect(workflow.trace.length).toBeGreaterThan(0)

        const active = JSON.parse(
          await readFile(join(ws.dir, ".axiomsec", "operation", slug, "workflow", "active.json"), "utf8"),
        )
        expect(active).toMatchObject({ kind: "runbook", id: "network-surface" })
      } finally {
        await ws.cleanup()
      }
    },
    180_000,
  )
})

describe.skipIf(!BIN)("play workflows", () => {
  test(
    "a play persists its trace, and a matching tool call advances the workflow",
    async () => {
      const ws = await workspace("play-workflow")
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/") {
            return new Response('<html><body><a href="/local">next</a></body></html>', {
              headers: { "content-type": "text/html" },
            })
          }
          return new Response("LOCAL", { headers: { "content-type": "text/html" } })
        },
      })
      try {
        const target = `http://127.0.0.1:${server.port}`
        const slug = await createOperation(ws, target)

        const played = await tool(ws, "play", { id: "web-surface", args: { target } })
        expect(played.code).toBe(0)
        expect(played.json?.result.output).toContain("# Play: Web Surface Map (web-surface)")
        expect(played.json?.result.output).toContain("Execute exactly one step per assistant message")
        expect(played.json?.result.metadata.play).toBe("web-surface")
        expect(played.json?.result.metadata.steps).toBeGreaterThan(0)

        const workflowPath = join(ws.dir, ".axiomsec", "operation", slug, "workflow", "play-web-surface.json")
        expect(existsSync(workflowPath)).toBe(true)
        const workflow = JSON.parse(await readFile(workflowPath, "utf8"))
        expect(workflow.trace.length).toBeGreaterThan(0)
        expect(workflow.args).toEqual({ target })

        const readiness = facts(ws, slug).filter((fact) => fact.entity_kind === "play")
        expect(readiness.some((fact) => fact.fact_name === "capsule_readiness")).toBe(true)
        expect(readiness.some((fact) => fact.fact_name === "capsule_execution")).toBe(true)

        // The first play step is a scanner crawl; executing it should advance
        // the trace and write workflow progress to the kernel.
        const crawled = await tool(ws, "scanner", {
          mode: "crawl",
          target: `${target}/`,
          options: { maxUrls: 5, maxDepth: 1, timeout: 5_000 },
        })
        expect(crawled.code).toBe(0)

        const after = JSON.parse(await readFile(workflowPath, "utf8"))
        const scannerStep = after.trace.find((step: Record<string, unknown>) => step["tool"] === "scanner")
        expect(scannerStep?.outcome).toBe("completed")
        expect(after.completed_steps).toBeGreaterThanOrEqual(1)
        const workflowEvents = ledger(ws, slug).filter((event) => event.source === "workflow")
        expect(workflowEvents.some((event) => event.kind === "fact.observed")).toBe(true)
      } finally {
        server.stop(true)
        await ws.cleanup()
      }
    },
    180_000,
  )
})
