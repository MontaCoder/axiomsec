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
