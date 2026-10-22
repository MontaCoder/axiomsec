import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { activeSlug, binaryPath, facts, ledger, run, workspace, type Workspace } from "../support/harness"

const BIN = binaryPath()

async function createOperation(ws: Workspace, label = "Verify", target = "http://127.0.0.1:18080", kind = "pentest") {
  const result = await run(ws, ["operation", "new", label, "--kind", kind, "--target", target])
  expect(result.code).toBe(0)
  const slug = /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1]
  expect(slug).toBeTruthy()
  return slug!
}

type DebugResult = {
  tool: string
  input: Record<string, unknown>
  result: {
    title: string
    output: string
    metadata: Record<string, any>
  }
}

async function tool(ws: Workspace, agent: string, id: string, params: Record<string, unknown>, extraEnv?: Record<string, string>) {
  const result = await run(
    ws,
    ["debug", "agent", agent, "--tool", id, "--params", JSON.stringify(params), "--dangerously-skip-permissions"],
    extraEnv,
  )
  const parsed = ((): DebugResult | undefined => {
    try {
      return JSON.parse(result.stdout) as DebugResult
    } catch {
      return undefined
    }
  })()
  return { ...result, json: parsed }
}

describe.skipIf(!BIN)("operation CLI lifecycle", () => {
  test(
    "create writes the kernel, activates the marker and reports through show/list",
    async () => {
      const ws = await workspace("op-lifecycle")
      try {
        const slug = await createOperation(ws, "Verify Lifecycle")
        expect(slug).toBe("verify-lifecycle")
        expect(await activeSlug(ws)).toBe(slug)

        const recorded = facts(ws, slug)
        const state = recorded.find((fact) => fact.fact_name === "operation_state")
        const scope = recorded.find((fact) => fact.fact_name === "scope_policy")
        expect(state?.value_json).toMatchObject({ label: "Verify Lifecycle", kind: "pentest", target: "http://127.0.0.1:18080" })
        expect(scope?.value_json).toMatchObject({ default: "ask", in_scope: ["127.0.0.1"], out_of_scope: [] })

        const shown = await run(ws, ["operation", "show", slug, "--format", "json"])
        expect(shown.code).toBe(0)
        const info = JSON.parse(shown.stdout)
        expect(info.operation).toMatchObject({ slug, label: "Verify Lifecycle", kind: "pentest", active: true })
        expect(info.scope_policy.in_scope).toEqual(["127.0.0.1"])
        expect(info.context_pack).toContain("## Scope")
        expect(info.context_pack).toContain("- in: 127.0.0.1")

        const listed = await run(ws, ["operation", "list", "--format", "json"])
        const ops = JSON.parse(listed.stdout)
        expect(ops).toHaveLength(1)
        expect(ops[0]).toMatchObject({ slug, active: true })

        const summary = await run(ws, ["operation", "show"])
        expect(summary.code).toBe(0)
        expect(summary.stdout).toContain(`verify-lifecycle [pentest] Verify Lifecycle`)
        expect(summary.stdout).toContain("opsec: normal")
        expect(summary.stdout).toContain("in_scope: 127.0.0.1")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "same-label creates cannot clobber each other",
    async () => {
      const ws = await workspace("op-collision")
      try {
        const first = await createOperation(ws, "Collision")
        const second = await createOperation(ws, "Collision")
        const third = await createOperation(ws, "Collision")
        expect(new Set([first, second, third]).size).toBe(3)
        for (const slug of [first, second, third]) {
          const state = facts(ws, slug).find((fact) => fact.fact_name === "operation_state")
          expect(state).toBeTruthy()
        }
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "use switches the marker and archive clears it without deleting state",
    async () => {
      const ws = await workspace("op-switch")
      try {
        const first = await createOperation(ws, "First")
        const second = await createOperation(ws, "Second")
        expect(await activeSlug(ws)).toBe(second)

        const use = await run(ws, ["operation", "use", first])
        expect(use.code).toBe(0)
        expect(await activeSlug(ws)).toBe(first)
        expect(facts(ws, first).length).toBeGreaterThan(0)

        const archive = await run(ws, ["operation", "archive", first])
        expect(archive.code).toBe(0)
        expect(await activeSlug(ws)).toBeUndefined()
        expect(facts(ws, first).length).toBeGreaterThan(0)

        const show = await run(ws, ["operation", "show"])
        expect(show.code).toBe(1)
        expect(show.stderr).toContain("no active operation")
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "show and use reject unknown and invalid slugs",
    async () => {
      const ws = await workspace("op-unknown")
      try {
        await createOperation(ws, "Known")
        const show = await run(ws, ["operation", "show", "missing", "--format", "json"])
        expect(show.code).toBe(1)
        expect(show.stderr).toContain("operation not found: missing")
        const use = await run(ws, ["operation", "use", "../escape"])
        expect(use.code).toBe(1)
        expect(use.stderr).toContain("operation not found")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})

describe.skipIf(!BIN)("security-state permissions", () => {
  test(
    "scope changes require approval, persist in the kernel, and survive projection loss",
    async () => {
      const ws = await workspace("scope-persist")
      try {
        const slug = await createOperation(ws, "Scope")
        const denied = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "scope",
          "--params",
          JSON.stringify({ action: "set", level: "strict" }),
        ])
        expect(denied.code).toBe(1)
        expect(denied.stderr).toContain("permission 'scope' resolves to ask")

        const changed = await tool(ws, "security", "scope", { action: "set", level: "strict" })
        expect(changed.code).toBe(0)
        expect(changed.json?.result.metadata).toMatchObject({ action: "set", level: "strict", slug })
        expect(changed.stderr).toContain("bypassing ask for scope")

        expect(facts(ws, slug).find((fact) => fact.fact_name === "scope_policy")?.value_json).toMatchObject({
          opsec: "strict",
        })

        // Removing the projection must not revert enforcement: SQLite is canonical.
        const projection = join(ws.dir, ".axiomsec", "operation", slug, "cyber", "facts.jsonl")
        await writeFile(projection, "")
        const status = await tool(ws, "security", "opsec", { action: "status" })
        expect(status.code).toBe(0)
        expect(status.json?.result.output).toContain("Opsec: strict")
        expect(status.json?.result.metadata).toMatchObject({ opsec: "strict" })
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "an explicit deny rule removes a tool from the model-facing surface",
    async () => {
      const ws = await workspace("deny-tool")
      try {
        await createOperation(ws, "Deny")
        const config = {
          ...(JSON.parse(ws.env.AXIOMSEC_CONFIG_CONTENT) as Record<string, unknown>),
          permission: { http_request: "deny", net: "deny" },
        }
        const env = { AXIOMSEC_CONFIG_CONTENT: JSON.stringify(config) }
        for (const id of ["http_request", "net"]) {
          const result = await run(ws, ["debug", "agent", "security", "--tool", id, "--params", "{}"], env)
          expect(result.code).toBe(1)
          // The registry removes the tool before the agent can see it, so the
          // debug command reports it as unavailable rather than prompting.
          expect(result.stderr).toMatch(new RegExp(`Tool ${id} (is disabled|not found) for agent security`))
        }

        const agent = await run(ws, ["debug", "agent", "security"], env)
        expect(agent.code).toBe(0)
        const info = JSON.parse(agent.stdout)
        // A denied tool is removed from the registry, not merely marked false.
        expect(Object.hasOwn(info.tools, "http_request")).toBe(false)
        expect(Object.hasOwn(info.tools, "net")).toBe(false)
        expect(info.tools.scope).toBe(true)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "observation writes require approval while reads do not",
    async () => {
      const ws = await workspace("observation-gate")
      try {
        const slug = await createOperation(ws, "Observe")
        const denied = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "observation",
          "--params",
          JSON.stringify({ action: "add", subtype: "vuln", title: "canary" }),
        ])
        expect(denied.code).toBe(1)
        expect(denied.stderr).toContain("permission 'observation' resolves to ask")

        const read = await tool(ws, "security", "observation", { action: "list" })
        expect(read.code).toBe(0)
        expect(read.json?.result.output).toContain("No observations.")
        expect(read.stderr).not.toContain("bypassing ask")

        const added = await tool(ws, "security", "observation", {
          action: "add",
          subtype: "vuln",
          title: "Reflected XSS",
          severity: "high",
          confidence: 0.8,
          tags: ["xss"],
        })
        expect(added.code).toBe(0)
        expect(added.json?.result.metadata).toMatchObject({ action: "add", status: "open" })
        const id = added.json?.result.metadata.id as string
        expect(id).toBeTruthy()

        const list = await tool(ws, "security", "observation", { action: "list" })
        expect(list.json?.result.output).toContain("total=1 critical=0 high=1")
        expect(list.json?.result.output).toContain("Reflected XSS")

        const updated = await tool(ws, "security", "observation", { action: "update", id, status: "confirmed" })
        expect(updated.json?.result.output).toContain("status: confirmed")

        const removed = await tool(ws, "security", "observation", { action: "remove", id })
        expect(removed.json?.result.metadata).toMatchObject({ removed: true })
        const after = await tool(ws, "security", "observation", { action: "list" })
        expect(after.json?.result.output).toContain("No observations.")

        const events = ledger(ws, slug)
        expect(events.filter((event) => event.kind === "tool.called" && event.source === "observation").length).toBeGreaterThanOrEqual(5)
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )
})

describe.skipIf(!BIN)("evidence, findings and the deliverable agree", () => {
  test(
    "the full proof chain reaches a consistent report bundle",
    async () => {
      const ws = await workspace("proof-chain")
      try {
        const slug = await createOperation(ws, "Proof Chain")

        // A fabricated ref is rejected without writing anything.
        const fabricated = await tool(ws, "security", "finding", {
          action: "promote",
          key: "fabricated",
          evidence: ["a".repeat(64)],
          replay: "trust me",
        })
        expect(fabricated.json?.result.metadata).toMatchObject({ promoted: false, unresolved_evidence: ["a".repeat(64)] })
        expect(fabricated.json?.result.output).toContain("do not resolve")

        // A real artifact promotes only when the evidence gate and replay half both hold.
        const evidence = await tool(ws, "security", "evidence", {
          action: "add_text",
          text: "HTTP 200 with vulnerable parameter on /search?q=<script>",
          label: "xss-proof",
        })
        const sha = evidence.json?.result.metadata.sha256 as string
        expect(sha).toMatch(/^[0-9a-f]{64}$/)

        const promoted = await tool(ws, "security", "finding", {
          action: "promote",
          key: "xss",
          title: "Reflected XSS",
          severity: "high",
          evidence: [sha],
          replay: "curl -s 'http://127.0.0.1:18080/search?q=<script>alert(1)</script>'",
        })
        expect(promoted.json?.result.metadata).toMatchObject({ status: "verified", oracle_status: "passed" })
        const replayRef = promoted.json?.result.metadata.replay_ref as string
        expect(replayRef).toMatch(/^[0-9a-f]{64}$/)
        expect(replayRef).not.toBe(sha)

        const exempt = await tool(ws, "security", "finding", {
          action: "promote",
          key: "upstream",
          title: "Upstream dependency flaw",
          evidence: [sha],
          replay_exemption_category: "external_dependency",
          replay_exemption_rationale: "third-party service is outside the engagement",
        })
        expect(exempt.json?.result.metadata).toMatchObject({ status: "verified", oracle_status: "passed" })
        expect(exempt.json?.result.metadata.replay_ref).toBeUndefined()

        const status = await tool(ws, "security", "finding", { action: "status", key: "xss" })
        expect(status.json?.result.metadata).toMatchObject({ found: true, kind: "finding", status: "verified" })
        expect(status.json?.result.output).toContain("replay: present")

        const rejected = await tool(ws, "security", "finding", { action: "reject", key: "upstream", note: "duplicate" })
        expect(rejected.json?.result.metadata).toMatchObject({ rejected: true })
        const rejectedStatus = await tool(ws, "security", "finding", { action: "status", key: "upstream" })
        expect(rejectedStatus.json?.result.metadata).toMatchObject({ found: true, status: "rejected" })

        const built = await tool(ws, "security", "report", { action: "build" })
        expect(built.json?.result.metadata.available).toBe(true)
        const bundle = built.json?.result.metadata.bundle_dir as string
        const reportPath = built.json?.result.metadata.report_path as string
        const manifestPath = built.json?.result.metadata.manifest_path as string
        expect(existsSync(reportPath)).toBe(true)
        expect(existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
        expect(manifest.counts.reportable_findings).toBe(1)
        expect(manifest.counts.rejected_findings).toBe(1)
        expect(manifest.counts.evidence).toBeGreaterThanOrEqual(2)
        const report = await readFile(reportPath, "utf8")
        expect(report).toContain("## Reportable Findings")
        expect(report).toContain("**Reflected XSS**")
        expect(report).toContain("## Rejected Or Stale Findings")
        expect(report).toContain("**Upstream dependency flaw**")
        expect(report).toContain(sha)
        expect(report).toContain(replayRef)

        // The manifest digest must match the bytes on disk.
        const manifestBytes = await readFile(manifestPath)
        const digest = createHash("sha256").update(manifestBytes).digest("hex")
        const seal = await readFile(join(bundle, "manifest.sha256"), "utf8")
        expect(seal.trim()).toBe(`${digest}  manifest.json`)
        for (const file of manifest.files as Array<{ path: string; sha256: string }>) {
          const bytes = await readFile(join(bundle, file.path))
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256)
        }

        const listed = await tool(ws, "security", "evidence", { action: "list" })
        expect(listed.json?.result.metadata.count).toBeGreaterThanOrEqual(2)
        const fetched = await tool(ws, "security", "evidence", { action: "get", sha256: sha })
        expect(fetched.json?.result.metadata).toMatchObject({ found: true, sha256: sha })
        expect(fetched.json?.result.output).toContain("HTTP 200")
        const search = await tool(ws, "security", "evidence", { action: "search", query: "xss-proof" })
        expect(search.json?.result.metadata.count).toBeGreaterThanOrEqual(1)

        const proofEvents = ledger(ws, slug).filter((event) => event.source === "oracle")
        expect(proofEvents.length).toBeGreaterThanOrEqual(2)
        expect(proofEvents.every((event) => event.kind === "fact.verified")).toBe(true)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "evidence add_file respects the read and external-directory gates",
    async () => {
      const ws = await workspace("evidence-file")
      try {
        await createOperation(ws, "Evidence File")
        await writeFile(join(ws.dir, ".env"), "CANARY=supersecret\n")
        const denied = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "evidence",
          "--params",
          JSON.stringify({ action: "add_file", path: ".env", label: "env" }),
        ])
        expect(denied.code).toBe(1)
        expect(denied.stderr).toContain("permission 'read' resolves to ask")

        const stored = await tool(ws, "security", "evidence", { action: "add_file", path: ".env", label: "env" })
        expect(stored.code).toBe(0)
        expect(stored.json?.result.metadata.sha256).toMatch(/^[0-9a-f]{64}$/)

        // The stored bytes are the file's content, not a path reference.
        const sha = stored.json?.result.metadata.sha256 as string
        const fetched = await tool(ws, "security", "evidence", { action: "get", sha256: sha })
        expect(fetched.json?.result.output).toContain("CANARY=supersecret")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})
