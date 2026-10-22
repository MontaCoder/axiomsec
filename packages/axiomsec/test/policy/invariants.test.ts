import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "..", "src")
const TOOLS = join(SRC, "tools")

function sourceFiles(root: string): string[] {
  const glob = new Bun.Glob("**/*.ts")
  return [...glob.scanSync({ cwd: root, absolute: true })].sort()
}

async function read(file: string) {
  return Bun.file(file).text()
}

function relative(file: string) {
  return file.slice(SRC.length + 1).replace(/\\/g, "/")
}

/**
 * Target-touching egress. A tool that reaches the network or a browser must
 * clear the operation boundary first.
 */
const EGRESS = /\b(?:await\s+)?(?:fetch\(|Bun\.spawn\(|net\.connect\(|chromium\.launch\()/

/**
 * Tools that perform egress without a boundary check, and why. Each entry is an
 * accepted exception recorded in the risk register — an exception has to be
 * written down to survive, which is the point of the list.
 */
const EGRESS_EXCEPTIONS: Record<string, string> = {
  // RISK-SCOPE-03: a shell can egress anywhere. Accepted: the tool asks first
  // and the boundary cannot be enforced for an arbitrary command.
  "bash.ts": "RISK-SCOPE-03",
  // Local process helper for triage output, not a target request.
  "process.ts": "local process, no target egress",
  // Runs the local `tar` binary to build a share bundle.
  "share.ts": "local process, no target egress",
  // Spawns the local interactsh client, which the operator asked to start.
  "interact.ts": "operator-started local client, asks first",
}

describe("every tool goes through the wrapper (ENG-04)", () => {
  test("a tool file must define its tool with Tool.define", async () => {
    const offenders: string[] = []
    for (const file of sourceFiles(TOOLS)) {
      const text = await read(file)
      // A tool file exports something like `export const FooTool = ...`.
      if (!/export\s+const\s+\w*Tool\b/.test(text)) continue
      // Tool.define may carry explicit type parameters before the call.
      if (!/Tool\.define\b/.test(text)) offenders.push(relative(file))
    }
    expect(offenders).toEqual([])
  })
})

describe("side-effect categories are a closed set (ENG-04)", () => {
  test("Tool.sideEffects may only use the declared categories", async () => {
    const known = new Set([
      "read_only",
      "writes_ledger",
      "writes_facts",
      "writes_evidence",
      "network",
      "mutates_target",
      "mutates_workspace",
    ])
    const offenders: string[] = []
    for (const file of [...sourceFiles(TOOLS), ...sourceFiles(join(SRC, "core"))]) {
      const text = await read(file)
      for (const match of text.matchAll(/Tool\.sideEffects\(([^)]*)\)/g)) {
        for (const raw of match[1].split(",")) {
          const value = raw.trim().replace(/^["']|["']$/g, "")
          if (!value) continue
          if (!known.has(value)) offenders.push(`${relative(file)}: ${value}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("every built-in tool id has a default side-effect contract", async () => {
    const text = await read(join(TOOLS, "tool.ts"))
    const block = text.slice(text.indexOf("DEFAULT_SIDE_EFFECTS"), text.indexOf("\n}", text.indexOf("DEFAULT_SIDE_EFFECTS")))
    const declared = new Map<string, string[]>()
    for (const match of block.matchAll(/^\s{2}([a-z_]+):\s*\[([^\]]*)\]/gm)) {
      declared.set(
        match[1],
        match[2]
          .split(",")
          .map((item) => item.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean),
      )
    }

    const ids = new Set<string>()
    for (const file of sourceFiles(TOOLS)) {
      const source = await read(file)
      for (const match of source.matchAll(/Tool\.define(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)) ids.add(match[1])
    }

    // TaskTool takes its id from a variable, so the source regex cannot see it.
    const indirect = new Set(["task"])
    expect([...ids].filter((id) => !declared.has(id))).toEqual([])
    expect([...declared.keys()].filter((id) => !ids.has(id) && !indirect.has(id))).toEqual([])
    const known = new Set([
      "read_only",
      "writes_ledger",
      "writes_facts",
      "writes_evidence",
      "network",
      "mutates_target",
      "mutates_workspace",
    ])
    const invalid = [...declared].flatMap(([id, effects]) =>
      effects.filter((effect) => !known.has(effect)).map((effect) => `${id}: ${effect}`),
    )
    expect(invalid).toEqual([])
  })
})

describe("target egress is boundary-checked (SEC-01, SEC-02)", () => {
  test("a tool that reaches the network or a browser must consult the Guard", async () => {
    const offenders: string[] = []
    for (const file of sourceFiles(TOOLS)) {
      const name = file.split(/[\\/]/).pop()!
      if (EGRESS_EXCEPTIONS[name]) continue
      const text = await read(file)
      if (!EGRESS.test(text)) continue
      const guarded = /Guard\.(check|checkUrl|checkHost|checkPath)/.test(text) || /GuardedHttp/.test(text)
      if (!guarded) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  test("the recorded exceptions are still recorded", async () => {
    // If an exception is removed from the list, the tool must be guarded.
    for (const [name, reason] of Object.entries(EGRESS_EXCEPTIONS)) {
      expect(reason.length).toBeGreaterThan(0)
      const text = await read(join(TOOLS, name))
      if (name === "process.ts" || name === "share.ts") continue
      expect(text.length).toBeGreaterThan(0)
    }
  })
})

describe("operation paths keep their containment checks (SEC-01)", () => {
  test("the evidence locker resolves its directory through the slug rules", async () => {
    const text = await read(join(SRC, "core", "evidence", "store.ts"))
    expect(text).toContain("containedPath")
  })

  test("operation directory resolution goes through the slug rules", async () => {
    const text = await read(join(SRC, "core", "operation", "operation.ts"))
    expect(text).toContain("containedPath")
    expect(text).toContain("isValidSlug")
  })

  test("the deliverable bundle resolves its directory through the slug rules", async () => {
    const text = await read(join(SRC, "core", "deliverable", "build.ts"))
    expect(text).toContain("containedPath")
  })
})

describe("security-state tools cannot fall through the catch-all allow (SEC-03)", () => {
  test("autonomy, mcp and adapter triage are explicit ask defaults", async () => {
    const text = await read(join(SRC, "agent", "agent.ts"))
    for (const key of ["autonomy", "mcp", "binary_triage", "iac_triage", "cloud_posture", "container_surface"]) {
      expect(text).toContain(`${key}: "ask"`)
    }
  })

  test("MCP uses the mcp permission with a tool-key pattern", async () => {
    const text = await read(join(SRC, "session", "prompt.ts"))
    expect(text).toContain('const permission = "mcp"')
    expect(text).toContain("patterns: [key]")
    expect(text).not.toContain('const permission = `mcp:${key}`')
  })

  test("per-prompt tool toggles are merged before the session ruleset", async () => {
    const text = await read(join(SRC, "session", "prompt.ts"))
    const index = text.indexOf("Per-prompt tool toggles")
    expect(index).toBeGreaterThan(0)
    const nearby = text.slice(index, index + 700)
    expect(nearby).toContain("Permission.merge(permissions, session.permission ?? [])")
  })
})

describe("the audit wrapper records the attempt before validation (ENG-04)", () => {
  test("tool.called is written before the argument schema parse", async () => {
    const text = await read(join(SRC, "tools", "tool.ts"))
    const called = text.indexOf('kind: "tool.called"')
    const parse = text.indexOf("toolInfo.parameters.parse")
    expect(called).toBeGreaterThan(0)
    expect(parse).toBeGreaterThan(0)
    expect(called).toBeLessThan(parse)
  })
})

describe("discovered subresources keep their boundary callbacks (SEC-02)", () => {
  test("dir-fuzz checks every word through allowUrl", async () => {
    const text = await read(join(SRC, "scanners", "dir-fuzzer.ts"))
    expect(text).toContain("allowUrl")
    expect(text).toContain("blocked++")
  })

  test("appsec probe checks each planned route through allowUrl", async () => {
    const text = await read(join(SRC, "tools", "appsec-probe.ts"))
    expect(text).toContain("input.allowUrl")
    expect(text).toContain("routesFor(origin, probePlan, timeout, ctx.abort, allowUrl)")
  })
})
