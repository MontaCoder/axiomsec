import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binaryPath, run, workspace, type Workspace } from "../support/harness"

const BIN = binaryPath()

function combined(result: { stdout: string; stderr: string }): string {
  return result.stdout + result.stderr
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/")
}

describe.skipIf(!BIN)("CLI surface: discovery and help", () => {
  test(
    "--version prints the package version and exits cleanly",
    async () => {
      const ws = await workspace("surface-version")
      try {
        const result = await run(ws, ["--version"])
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
        expect(result.stderr).toBe("")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "--help lists every top-level command",
    async () => {
      const ws = await workspace("surface-help")
      try {
        const result = await run(ws, ["--help"])
        expect(result.code).toBe(0)
        const text = combined(result)
        for (const command of [
          "run [message..]",
          "operation",
          "session",
          "db",
          "replay",
          "export",
          "mcp",
          "plugin",
          "debug",
          "models",
          "providers",
          "serve",
          "stats",
          "generate",
        ]) {
          expect(text).toContain(command)
        }
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "an unknown command reports a failure instead of exiting 0 (RISK-CLI-03)",
    async () => {
      const ws = await workspace("surface-unknown")
      try {
        // The default command treats a bare argument as a project directory.
        const result = await run(ws, ["frobnicate"])
        expect(result.code).toBe(1)
        expect(combined(result)).toContain("Failed to change directory")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "agent list reports the native agent surface",
    async () => {
      const ws = await workspace("surface-agents")
      try {
        const result = await run(ws, ["agent", "list"])
        expect(result.code).toBe(0)
        const text = combined(result)
        expect(text).toContain("appsec (primary)")
        expect(text).toContain("pentest")
        expect(text).toContain("osint")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "debug paths prints every global path inside the workspace state",
    async () => {
      const ws = await workspace("surface-paths")
      try {
        const result = await run(ws, ["debug", "paths"])
        expect(result.code).toBe(0)
        const lines = result.stdout.trim().split(/\r?\n/)
        const labels = lines.map((line) => line.split(/\s+/)[0])
        expect(labels).toEqual(expect.arrayContaining(["data", "config", "cache", "state", "log", "bin"]))
        expect(normalize(result.stdout)).toContain(normalize(ws.dir))
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})

describe.skipIf(!BIN)("CLI surface: debug filesystem utilities", () => {
  async function seed(ws: Workspace): Promise<void> {
    await writeFile(join(ws.dir, "alpha.txt"), "alpha needle\n")
    await mkdir(join(ws.dir, "sub"), { recursive: true })
    await writeFile(join(ws.dir, "sub", "beta.md"), "beta content\n")
    await writeFile(join(ws.dir, "unique-marker-file.txt"), "marker\n")
  }

  test(
    "debug rg files honours --query and --limit (RISK-CLI-04)",
    async () => {
      const ws = await workspace("surface-rg-files")
      try {
        await seed(ws)
        const all = await run(ws, ["debug", "rg", "files"])
        expect(all.code).toBe(0)
        expect(all.stdout).toContain("alpha.txt")
        expect(all.stdout).toContain("unique-marker-file.txt")

        const filtered = await run(ws, ["debug", "rg", "files", "--query", "alpha"])
        expect(filtered.code).toBe(0)
        expect(filtered.stdout).toContain("alpha.txt")
        expect(filtered.stdout).not.toContain("unique-marker-file.txt")
        expect(filtered.stdout).not.toContain("beta.md")

        const none = await run(ws, ["debug", "rg", "files", "--query", "no-such-file-anywhere"])
        expect(none.code).toBe(0)
        expect(none.stdout.trim()).toBe("")

        const limited = await run(ws, ["debug", "rg", "files", "--limit", "1"])
        expect(limited.code).toBe(0)
        expect(limited.stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1)
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "debug rg search and tree return usable results",
    async () => {
      const ws = await workspace("surface-rg-search")
      try {
        await seed(ws)
        const search = await run(ws, ["debug", "rg", "search", "needle"])
        expect(search.code).toBe(0)
        const matches: Array<{ path: { text: string }; lines: { text: string } }> = JSON.parse(search.stdout)
        expect(matches.some((match) => match.path.text.includes("alpha.txt") && match.lines.text.includes("needle"))).toBe(
          true,
        )

        const tree = await run(ws, ["debug", "rg", "tree"])
        expect(tree.code).toBe(0)
        expect(tree.stdout).toContain("sub")
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "debug file read returns the file content",
    async () => {
      const ws = await workspace("surface-file-read")
      try {
        await seed(ws)
        const result = await run(ws, ["debug", "file", "read", "alpha.txt"])
        expect(result.code).toBe(0)
        const payload = JSON.parse(result.stdout)
        expect(payload).toMatchObject({ type: "text", content: "alpha needle" })

        const listed = await run(ws, ["debug", "file", "list", "sub"])
        expect(listed.code).toBe(0)
        const files = JSON.parse(listed.stdout)
        expect(Array.isArray(files)).toBe(true)
        expect(JSON.stringify(files)).toContain("beta.md")
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "debug scrap and debug skill return their registries as JSON",
    async () => {
      const ws = await workspace("surface-registries")
      try {
        const scrap = await run(ws, ["debug", "scrap"])
        expect(scrap.code).toBe(0)
        expect(Array.isArray(JSON.parse(scrap.stdout))).toBe(true)

        const skills = await run(ws, ["debug", "skill"])
        expect(skills.code).toBe(0)
        const list: Array<{ name?: string; location?: string }> = JSON.parse(skills.stdout)
        expect(Array.isArray(list)).toBe(true)
        const builtin = list.find((skill) => typeof skill.location === "string" && skill.location.startsWith("builtin:"))
        expect(builtin).toBeTruthy()
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )
})

describe.skipIf(!BIN)("CLI surface: sessions, database and diagnostics", () => {
  test(
    "session list emits valid JSON for an empty workspace and delete rejects unknown ids",
    async () => {
      const ws = await workspace("surface-session")
      try {
        const list = await run(ws, ["session", "list", "--format", "json"])
        expect(list.code).toBe(0)
        expect(JSON.parse(list.stdout)).toEqual([])

        const deleted = await run(ws, ["session", "delete", "ses_does_not_exist"])
        expect(deleted.code).toBe(1)
        expect(combined(deleted)).toContain("Session not found")
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "db path and db query agree with the configured database",
    async () => {
      const ws = await workspace("surface-db")
      try {
        const path = await run(ws, ["db", "path"])
        expect(path.code).toBe(0)
        expect(normalize(path.stdout.trim())).toBe(normalize(ws.env.AXIOMSEC_DB))

        const query = await run(ws, ["db", "select count(*) as n from cyber_fact", "--format", "json"])
        expect(query.code).toBe(0)
        expect(JSON.parse(query.stdout)).toEqual([{ n: 0 }])

        const tsv = await run(ws, ["db", "select 1 as n"])
        expect(tsv.code).toBe(0)
        expect(tsv.stdout.replace(/\r/g, "").trim().split("\n")).toEqual(["n", "1"])

        const bad = await run(ws, ["db", "select * from table_that_does_not_exist"])
        expect(bad.code).toBe(1)
        expect(combined(bad)).toContain("no such table")
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "models rejects an unknown provider with a non-zero exit (RISK-CLI-05)",
    async () => {
      const ws = await workspace("surface-models")
      try {
        const unknown = await run(ws, ["models", "nosuch"])
        expect(unknown.code).toBe(1)
        expect(combined(unknown)).toContain("Provider not found: nosuch")

        const verbose = await run(ws, ["models", "mock", "--verbose"])
        expect(verbose.code).toBe(0)
        expect(verbose.stdout).toContain("mock/mock-model")
        expect(verbose.stdout).toContain('"name": "Mock"')
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "mcp list succeeds when no servers are configured",
    async () => {
      const ws = await workspace("surface-mcp")
      try {
        const result = await run(ws, ["mcp", "list"])
        expect(result.code).toBe(0)
        expect(combined(result)).toContain("No MCP servers configured")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "stats accepts day and model filters in an empty workspace",
    async () => {
      const ws = await workspace("surface-stats")
      try {
        const result = await run(ws, ["stats", "--days", "0", "--models", "--project", ""])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("OVERVIEW")
        expect(result.stdout).toContain("0")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})

describe.skipIf(!BIN)("CLI surface: malformed input fails loudly", () => {
  test(
    "invalid configuration is rejected instead of silently defaulting",
    async () => {
      const ws = await workspace("surface-config")
      try {
        const result = await run(ws, ["models"], { AXIOMSEC_CONFIG_CONTENT: "{bad" })
        expect(result.code).toBe(1)
        expect(combined(result)).toMatch(/CloseBraceExpected|InvalidSymbol|Error/)
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "export and replay reject missing sessions and files",
    async () => {
      const ws = await workspace("surface-export")
      try {
        const exported = await run(ws, ["export", "ses_nope"])
        expect(exported.code).toBe(1)
        expect(combined(exported)).toContain("Session not found: ses_nope")

        const shown = await run(ws, ["replay", "show", "missing.axiomsec"])
        expect(shown.code).toBe(1)

        await writeFile(join(ws.dir, "broken.axiomsec"), "not a replay file\n")
        const verified = await run(ws, ["replay", "verify", "broken.axiomsec"])
        expect(verified.code).toBe(1)
        expect(combined(verified)).toContain("Error")
      } finally {
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "pr refuses to run outside a git repository",
    async () => {
      const ws = await workspace("surface-pr")
      try {
        const result = await run(ws, ["pr", "1"])
        expect(result.code).toBe(1)
        expect(combined(result)).toContain("Could not find git repository")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "operation rejects an unknown kind and a missing slug",
    async () => {
      const ws = await workspace("surface-operation")
      try {
        const invalid = await run(ws, ["operation", "new", "Bad", "--kind", "bogus"])
        expect(invalid.code).toBe(1)
        // yargs renders the command help (including the valid choices) on an
        // invalid option value.
        expect(combined(invalid)).toContain("--kind")
        expect(combined(invalid)).toContain('"pentest"')

        const missing = await run(ws, ["operation", "show", "missing", "--format", "json"])
        expect(missing.code).toBe(1)
        expect(combined(missing)).toContain("operation not found: missing")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})
