import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binaryPath, facts, ledger, readDb, run, workspace, type Workspace } from "../support/harness"

const BIN = binaryPath()

async function createOperation(ws: Workspace) {
  const result = await run(ws, ["operation", "new", "Tool Surface", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
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

describe.skipIf(!BIN)("vault secret containment (SEC-06)", () => {
  test(
    "set, reveal and delete are permissioned and the transcript never stores the value",
    async () => {
      const ws = await workspace("vault-canary")
      try {
        const slug = await createOperation(ws)
        const key = "canary-key"
        const canary = "VAULT-CANARY-4f7a9"

        const denied = await tool(ws, "vault", { action: "set", key, value: canary }, false)
        expect(denied.code).toBe(1)
        expect(denied.stderr).toContain("permission 'vault' resolves to ask")

        const stored = await tool(ws, "vault", { action: "set", key, value: canary })
        expect(stored.code).toBe(0)
        expect(stored.json?.result.output).toContain("[REDACTED:")
        expect(stored.json?.result.output).not.toContain(canary)

        // The ledger args, the transcript part and the tool output are redacted.
        const events = ledger(ws, slug)
        const called = events.find((event) => event.kind === "tool.called" && event.source === "vault")
        expect(called?.data["input"]).toMatchObject({ action: "set", key })
        expect(JSON.stringify(called)).not.toContain(canary)
        expect(JSON.stringify(events)).not.toContain(canary)

        const db = readDb(ws)
        try {
          const parts = db.query("SELECT data FROM part").all() as Array<{ data: string }>
          const serialized = parts.map((row) => row.data).join("\n")
          expect(serialized).not.toContain(canary)
        } finally {
          db.close()
        }

        const vaultFile = join(ws.env.XDG_CONFIG_HOME, "axiomsec", "vault.json")
        expect(existsSync(vaultFile)).toBe(true)
        expect(await readFile(vaultFile, "utf8")).toContain(canary)

        const summary = await tool(ws, "vault", { action: "get", key, reveal: false })
        expect(summary.json?.result.output).toContain(`"present":true`)
        expect(summary.json?.result.output).not.toContain(canary)

        const revealDenied = await tool(ws, "vault", { action: "get", key, reveal: true }, false)
        expect(revealDenied.code).toBe(1)
        expect(revealDenied.stderr).toContain("permission 'vault' resolves to ask")

        const revealed = await tool(ws, "vault", { action: "get", key, reveal: true })
        expect(revealed.json?.result.output).toBe(canary)

        const listed = await tool(ws, "vault", { action: "list" })
        expect(listed.json?.result.output).toContain(key)

        const deleteDenied = await tool(ws, "vault", { action: "delete", key }, false)
        expect(deleteDenied.code).toBe(1)
        const deleted = await tool(ws, "vault", { action: "delete", key })
        expect(deleted.json?.result.output).toContain("deleted")
        const gone = await tool(ws, "vault", { action: "get", key }, false)
        expect(gone.code).toBe(1)
        expect(gone.stdout + gone.stderr).toContain("unknown key")
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("autonomy permission (RISK-PERM-09)", () => {
  test(
    "session self-elevation requires an explicit approval and is recorded",
    async () => {
      const ws = await workspace("autonomy-gate")
      try {
        const slug = await createOperation(ws)
        const denied = await tool(ws, "autonomy", { action: "set", mode: "auto" }, false)
        expect(denied.code).toBe(1)
        expect(denied.stderr).toContain("permission 'autonomy' resolves to ask")

        const allowed = await tool(ws, "autonomy", { action: "set", mode: "auto" })
        expect(allowed.code).toBe(0)
        expect(allowed.json?.result.output).toContain("Autonomy mode set to auto")
        expect(facts(ws, slug).find((fact) => fact.fact_name === "autonomy_policy")?.value_json).toMatchObject({
          mode: "auto",
        })

        const status = await tool(ws, "autonomy", { action: "status" }, false)
        expect(status.code).toBe(0)
        expect(status.json?.result.output).toContain("Autonomy mode:")
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )
})

describe.skipIf(!BIN)("adapter-backed triage degrades cleanly", () => {
  const cases: Array<{ tool: string; agent: string; adapter: string; params: Record<string, unknown>; text: string }> = [
    { tool: "binary_triage", agent: "hacking", adapter: "checksec", params: { path: "a.bin" }, text: "checksec" },
    { tool: "iac_triage", agent: "appsec", adapter: "checkov", params: { path: ".", mode: "quick" }, text: "checkov" },
    { tool: "cloud_posture", agent: "pentest", adapter: "prowler", params: { provider: "aws", mode: "quick" }, text: "prowler" },
    {
      tool: "container_surface",
      agent: "pentest",
      adapter: "trivy",
      params: { image: "nginx:latest", mode: "quick" },
      text: "trivy",
    },
  ]

  test.each(cases)("$tool reports a missing $adapter adapter", async (item) => {
    if (Bun.which(item.adapter)) return
    const ws = await workspace(`adapter-${item.tool}`)
    try {
      await createOperation(ws)
      const result = await run(ws, [
        "debug",
        "agent",
        item.agent,
        "--tool",
        item.tool,
        "--params",
        JSON.stringify(item.params),
      ])
      expect(result.code).toBe(0)
      const json = JSON.parse(result.stdout) as { result: { output: string; metadata: Record<string, any> } }
      expect(json.result.output).toContain("Required adapter")
      expect(json.result.output).toContain(item.text)
      expect(json.result.output).toContain("not installed")
      expect(json.result.metadata.available).toBe(false)
    } finally {
      await ws.cleanup()
    }
  }, 90_000)
})

describe.skipIf(!BIN)("skill discovery and loading", () => {
  test(
    "a configured skill loads its content and bundled files, and a builtin is always available",
    async () => {
      const ws = await workspace("skill-load")
      try {
        const skillDir = join(ws.dir, "skills", "custom")
        await mkdir(join(skillDir, "scripts"), { recursive: true })
        await writeFile(
          join(skillDir, "SKILL.md"),
          ["---", "name: custom-skill", "description: A test skill.", "---", "", "# Custom Skill", "CUSTOM-SKILL-CONTENT"].join(
            "\n",
          ),
        )
        await writeFile(join(skillDir, "scripts", "run.sh"), "echo test\n")
        const config = {
          ...(JSON.parse(ws.env.AXIOMSEC_CONFIG_CONTENT) as Record<string, unknown>),
          skills: { paths: [join(ws.dir, "skills")] },
        }
        const env = { AXIOMSEC_CONFIG_CONTENT: JSON.stringify(config) }
        await createOperation(ws)

        const loaded = await run(
          ws,
          ["debug", "agent", "security", "--tool", "skill", "--params", JSON.stringify({ name: "custom-skill" })],
          env,
        )
        expect(loaded.code).toBe(0)
        const output = JSON.parse(loaded.stdout).result.output as string
        expect(output).toContain("CUSTOM-SKILL-CONTENT")
        expect(output).toContain("<skill_content name=\"custom-skill\">")
        expect(output).toContain("scripts")
        expect(output).toContain("run.sh")

        const builtin = await run(
          ws,
          ["debug", "agent", "security", "--tool", "skill", "--params", JSON.stringify({ name: "passive-osint" })],
          env,
        )
        expect(builtin.code).toBe(0)
        expect(JSON.parse(builtin.stdout).result.output).toContain("Passive OSINT kit")

        const missing = await run(
          ws,
          ["debug", "agent", "security", "--tool", "skill", "--params", JSON.stringify({ name: "does-not-exist" })],
          env,
        )
        expect(missing.code).toBe(1)
        expect(missing.stdout + missing.stderr).toContain("not found")
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("knowledge offline and opsec strict", () => {
  test(
    "opsec strict refuses target-specific queries before any external lookup",
    async () => {
      const ws = await workspace("knowledge-opsec")
      try {
        await createOperation(ws)
        const result = await tool(ws, "knowledge", {
          intent: "vuln_intel",
          action: "lookup",
          query: "http://127.0.0.1:18080/admin",
          mode: "opsec_strict",
        })
        expect(result.code).toBe(0)
        expect(result.json?.result.output).toContain("opsec_strict refused")
        expect(result.json?.result.metadata).toMatchObject({ mode: "opsec_strict" })
        expect(result.json?.result.metadata.degraded).toBe(true)
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "offline mode degrades with a visible cache-only error",
    async () => {
      const ws = await workspace("knowledge-offline")
      try {
        await createOperation(ws)
        const result = await tool(ws, "knowledge", {
          intent: "vuln_intel",
          action: "lookup",
          query: "CVE-2024-0001",
          mode: "offline",
        })
        expect(result.code).toBe(0)
        expect(result.json?.result.output).toContain("offline mode")
        expect(result.json?.result.metadata).toMatchObject({ mode: "offline", degraded: true })
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )
})

describe.skipIf(!BIN)("local crypto tool", () => {
  test(
    "hash, hmac, encode/decode and jwt_decode are deterministic",
    async () => {
      const ws = await workspace("crypto-tool")
      try {
        const hash = await tool(ws, "crypto", { op: "hash", algo: "sha256", data: "abc" })
        expect(hash.code).toBe(0)
        expect(hash.json?.result.output).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")

        const hmac = await tool(ws, "crypto", { op: "hmac", algo: "sha256", data: "abc", key: "key" })
        expect(hmac.code).toBe(0)
        expect(hmac.json?.result.output).toBe("9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab")

        const encoded = await tool(ws, "crypto", { op: "encode", codec: "base64", data: "hello" })
        expect(encoded.json?.result.output).toBe("aGVsbG8=")
        const decoded = await tool(ws, "crypto", { op: "decode", codec: "base64", data: "aGVsbG8=" })
        expect(decoded.json?.result.output).toBe("hello")

        const jwt = await tool(ws, "crypto", {
          op: "jwt_decode",
          token:
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.c2lnbmF0dXJl",
        })
        expect(jwt.code).toBe(0)
        expect(jwt.json?.result.output).toContain("John")
        expect(jwt.json?.result.output).toContain("HS256")

        const invalid = await tool(ws, "crypto", { op: "hash" })
        expect(invalid.code).toBe(1)
        expect(invalid.stdout + invalid.stderr).toContain("hash requires data")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})

describe.skipIf(!BIN)("methodology and doctor", () => {
  test(
    "methodology queries return the requested framework and phase",
    async () => {
      const ws = await workspace("methodology-tool")
      try {
        const ptes = await tool(ws, "methodology", { framework: "ptes" })
        expect(ptes.code).toBe(0)
        expect(ptes.json?.result.output).toContain("Intelligence Gathering")
        expect(ptes.json?.result.metadata).toMatchObject({ framework: "ptes" })

        const phase = await tool(ws, "methodology", { framework: "ptes", phase: "Intelligence Gathering" })
        expect(phase.json?.result.output).toContain("[")
        expect(phase.json?.result.metadata.matches).toBeGreaterThan(0)

        const mitre = await tool(ws, "methodology", { framework: "mitre", query: "phishing" })
        expect(mitre.json?.result.output.toLowerCase()).toContain("phishing")

        const missing = await tool(ws, "methodology", { framework: "wstg", phase: "NO-SUCH-PHASE" })
        expect(missing.json?.result.output).toContain("No phase")
        expect(missing.json?.result.metadata.matches).toBe(0)
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "doctor reports the workspace and capability surface",
    async () => {
      const ws = await workspace("doctor-tool")
      try {
        const result = await tool(ws, "doctor", {})
        expect(result.code).toBe(0)
        const metadata = result.json?.result.metadata
        expect(metadata?.tools_total).toBeGreaterThan(0)
        expect(metadata?.workspace_writable).toBe(true)
        expect(metadata?.plays_total).toBeGreaterThan(0)
        expect(typeof metadata?.browser_present).toBe("boolean")
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "tool results publish their side-effect and audit contract",
    async () => {
      const ws = await workspace("tool-contract")
      try {
        await createOperation(ws)
        const cryptoResult = await tool(ws, "crypto", { op: "hash", algo: "sha256", data: "abc" })
        expect(cryptoResult.code).toBe(0)
        expect(cryptoResult.json?.result.metadata.side_effects).toEqual(["read_only"])
        expect(cryptoResult.json?.result.metadata.audit_logged).toBe(true)

        const doctorResult = await tool(ws, "doctor", {})
        expect(doctorResult.code).toBe(0)
        expect(doctorResult.json?.result.metadata.side_effects).toEqual(["writes_ledger", "writes_facts"])
        expect(doctorResult.json?.result.metadata.audit_logged).toBe(true)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("agent tool surfaces", () => {
  test(
    "agent list exposes every primary agent",
    async () => {
      const ws = await workspace("agent-list")
      try {
        const result = await run(ws, ["agent", "list"])
        expect(result.code).toBe(0)
        for (const agent of ["security", "pentest", "appsec", "osint", "hacking"]) {
          expect(result.stdout).toContain(`${agent} (`)
        }
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "each specialist hides its out-of-lane tools",
    async () => {
      const ws = await workspace("agent-lanes")
      try {
        const get = async (agent: string) => {
          const result = await run(ws, ["debug", "agent", agent])
          expect(result.code).toBe(0)
          return JSON.parse(result.stdout) as { name: string; mode: string; tools: Record<string, boolean> }
        }
        const osint = await get("osint")
        expect(osint.mode).toBe("primary")
        for (const hidden of ["scanner", "appsec_probe", "binary_triage", "cloud_posture", "net", "crypto"]) {
          expect(Object.hasOwn(osint.tools, hidden)).toBe(false)
        }
        expect(osint.tools.http_request).toBe(true)

        const appsec = await get("appsec")
        for (const hidden of ["pwn_bootstrap", "interact", "crypto", "net", "cloud_posture"]) {
          expect(Object.hasOwn(appsec.tools, hidden)).toBe(false)
        }
        expect(appsec.tools.read).toBe(true)

        const security = await get("security")
        for (const hidden of ["pwn_bootstrap", "interact", "binary_triage"]) {
          expect(Object.hasOwn(security.tools, hidden)).toBe(false)
        }
        expect(security.tools.scope).toBe(true)
        const rules = (security as unknown as { permission: Array<{ permission: string; action: string }> }).permission
        for (const key of ["autonomy", "mcp", "binary_triage", "iac_triage", "cloud_posture", "container_surface"]) {
          expect(rules.some((rule) => rule.permission === key && rule.action === "ask")).toBe(true)
        }

        const pentest = await get("pentest")
        for (const hidden of ["binary_triage", "iac_triage"]) {
          expect(Object.hasOwn(pentest.tools, hidden)).toBe(false)
        }
        expect(pentest.tools.scanner).toBe(true)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})
