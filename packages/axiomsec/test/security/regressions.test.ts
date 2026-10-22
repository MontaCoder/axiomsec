import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { binaryPath, facts, ledger, run, workspace } from "../support/harness"

// These scenarios drive the real CLI, so they need the built binary. CI
// builds first, so there they always run; locally they skip without a build.
const BIN = binaryPath()

/**
 * Executable versions of the defects this series fixed. Each one is a
 * regression: if the fix is reverted, the test fails.
 */
describe.skipIf(!BIN)("proof independence (RISK-PROOF-03)", () => {
  test(
    "a replay string alone cannot promote a finding",
    async () => {
      const ws = await workspace("proof")
      try {
        await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
        const result = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "finding",
          "--params",
          JSON.stringify({ action: "promote", key: "self-certified", replay: "trust me" }),
        ])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("Promotion requires at least one evidence reference")
        expect(result.stdout).toContain('"promoted": false')

        // No finding may exist afterwards.
        const status = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "finding",
          "--params",
          JSON.stringify({ action: "status", key: "self-certified" }),
        ])
        expect(status.stdout).toContain("No candidate or finding with that key")
        expect(status.stdout).toContain('"found": false')
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "real evidence and replay are recorded as two distinct artifacts",
    async () => {
      const ws = await workspace("proof-ok")
      try {
        await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
        const evidence = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "evidence",
          "--params",
          JSON.stringify({ action: "add_text", text: "canary-evidence", label: "canary" }),
        ])
        const sha = /[0-9a-f]{64}/.exec(evidence.stdout)?.[0]
        expect(sha).toBeTruthy()

        const promoted = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "finding",
          "--params",
          JSON.stringify({ action: "promote", key: "real", evidence: [sha], replay: "steps to reproduce" }),
          "--dangerously-skip-permissions",
        ])
        expect(promoted.stdout).toContain('"status": "verified"')
        const evidenceRef = /"evidence_refs": \[\s*"([0-9a-f]{64})"/.exec(promoted.stdout)?.[1]
        const replayRef = /"replay_ref": "([0-9a-f]{64})"/.exec(promoted.stdout)?.[1]
        expect(evidenceRef).toBeTruthy()
        expect(replayRef).toBeTruthy()
        // The replay artifact must not be the evidence artifact.
        expect(evidenceRef).not.toBe(replayRef)
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})

describe.skipIf(!BIN)("operation slug containment (RISK-SCOPE-07)", () => {
  test(
    "a traversal slug is refused and writes nothing outside the operation tree",
    async () => {
      const ws = await workspace("slug")
      try {
        await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
        const result = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "workspace",
          "--params",
          JSON.stringify({ action: "rename", slug: "../..", label: "TRAVERSAL-CANARY" }),
        ])
        expect(result.stdout).toContain("Invalid operation slug")

        // Nothing may be written outside .axiomsec/operation/.
        expect(existsSync(join(ws.dir, "cyber"))).toBe(false)
        expect(existsSync(join(ws.dir, ".axiomsec", "cyber"))).toBe(false)
        expect(existsSync(join(ws.dir, "TRAVERSAL-CANARY"))).toBe(false)
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "a deep traversal slug is refused too",
    async () => {
      const ws = await workspace("slug-deep")
      try {
        const result = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "workspace",
          "--params",
          JSON.stringify({ action: "rename", slug: "../../../../evil", label: "X" }),
        ])
        expect(result.stdout).toContain("Invalid operation slug")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})

describe.skipIf(!BIN)("security-state writes ask for permission (RISK-PERM-07)", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["opsec", { action: "set", level: "strict" }, "scope"],
    ["scope", { action: "set", level: "normal" }, "scope"],
    ["observation", { action: "add", subtype: "vuln", title: "x" }, "observation"],
  ]

  for (const [tool, params, permission] of cases) {
    test(
      `${tool} requires an explicit approval before it writes`,
      async () => {
        const ws = await workspace(`perm-${tool}`)
        try {
          await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
          const result = await run(ws, [
            "debug",
            "agent",
            "security",
            "--tool",
            tool,
            "--params",
            JSON.stringify(params),
          ])
          expect(result.code).toBe(1)
          expect(result.stderr).toContain(`permission '${permission}' resolves to ask`)
        } finally {
          await ws.cleanup()
        }
      },
      60_000,
    )
  }

  test(
    "a read of the same state never asks",
    async () => {
      const ws = await workspace("perm-read")
      try {
        await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
        for (const tool of ["opsec", "scope"]) {
          const result = await run(ws, [
            "debug",
            "agent",
            "security",
            "--tool",
            tool,
            "--params",
            JSON.stringify({ action: "status" }),
          ])
          expect(result.code).toBe(0)
          expect(result.stderr).not.toContain("resolves to ask")
        }
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})

describe.skipIf(!BIN)("the kernel is canonical (RISK-PERSIST-04)", () => {
  test(
    "scope survives the loss of its projection",
    async () => {
      const ws = await workspace("canonical")
      try {
        await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
        const set = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "opsec",
          "--params",
          JSON.stringify({ action: "set", level: "strict" }),
          "--dangerously-skip-permissions",
        ])
        expect(set.code).toBe(0)

        // The scope must be in the database, not only in the projection.
        const rows = facts(ws, "verify").filter((fact) => fact.fact_name === "scope_policy")
        expect(rows.length).toBeGreaterThan(0)
        expect(rows[0]?.value_json["opsec"]).toBe("strict")

        // Removing the projection must not silently revert the enforcement.
        const projection = join(ws.dir, ".axiomsec", "operation", "verify", "cyber", "facts.jsonl")
        if (existsSync(projection)) Bun.write(projection, "")
        const status = await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "opsec",
          "--params",
          JSON.stringify({ action: "status" }),
          "--dangerously-skip-permissions",
        ])
        expect(status.stdout).toContain("Opsec: strict")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})

describe.skipIf(!BIN)("the tool wrapper is the audit boundary (RISK-AUDIT-01)", () => {
  test(
    "a tool call is recorded in the kernel ledger",
    async () => {
      const ws = await workspace("ledger")
      try {
        await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
        await run(ws, [
          "debug",
          "agent",
          "security",
          "--tool",
          "scope",
          "--params",
          JSON.stringify({ action: "status" }),
        ])
        const events = ledger(ws, "verify")
        const called = events.filter((event) => event.kind === "tool.called" && event.source === "scope")
        const completed = events.filter((event) => event.kind === "tool.completed" && event.source === "scope")
        expect(called.length).toBeGreaterThan(0)
        expect(completed.length).toBeGreaterThan(0)
        expect(called[0]?.data["tool"]).toBe("scope")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})
