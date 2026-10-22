import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { binaryPath, ledger, run, workspace, type Workspace } from "../support/harness"

const BIN = binaryPath()

async function createOperation(ws: Workspace) {
  const result = await run(ws, ["operation", "new", "Files", "--kind", "appsec", "--target", "http://127.0.0.1:18080"])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1]!
}

async function tool(
  ws: Workspace,
  id: string,
  params: Record<string, unknown>,
  options: { skip?: boolean } = {},
) {
  const args = ["debug", "agent", "security", "--tool", id, "--params", JSON.stringify(params)]
  if (options.skip !== false) args.push("--dangerously-skip-permissions")
  const result = await run(ws, args)
  const json = (() => {
    try {
      return JSON.parse(result.stdout) as {
        result: { title: string; output: string; metadata: Record<string, any> }
      }
    } catch {
      return undefined
    }
  })()
  return { ...result, json }
}

describe.skipIf(!BIN)("read, write and edit permissions", () => {
  test(
    "read enforces .env and external-directory rules, supports offsets and directories",
    async () => {
      const ws = await workspace("file-read")
      const outside = await mkdtemp(join(tmpdir(), "axiomsec-outside-"))
      try {
        await createOperation(ws)
        await writeFile(join(ws.dir, "hello.txt"), "alpha\nbeta\ngamma\n")
        await writeFile(join(ws.dir, ".env"), "READ-CANARY=1\n")
        await writeFile(join(ws.dir, ".env.example"), "SAFE=1\n")
        await mkdir(join(ws.dir, "sub"), { recursive: true })
        await writeFile(join(ws.dir, "sub", "one.txt"), "one\n")
        const outsideFile = join(outside, "outside.txt")
        await writeFile(outsideFile, "OUTSIDE-CONTENT\n")

        const full = await tool(ws, "read", { filePath: join(ws.dir, "hello.txt") })
        expect(full.code).toBe(0)
        expect(full.json?.result.output).toContain("beta")

        const sliced = await tool(ws, "read", { filePath: join(ws.dir, "hello.txt"), offset: 2, limit: 1 })
        expect(sliced.json?.result.output).toContain("beta")
        expect(sliced.json?.result.output).not.toContain("gamma")

        const directory = await tool(ws, "read", { filePath: join(ws.dir, "sub") })
        expect(directory.json?.result.output).toContain("one.txt")

        const missing = await tool(ws, "read", { filePath: join(ws.dir, "nope.txt") })
        expect(missing.code).toBe(1)
        expect(missing.stdout + missing.stderr).toContain("File not found")

        const secretDenied = await tool(ws, "read", { filePath: join(ws.dir, ".env") }, { skip: false })
        expect(secretDenied.code).toBe(1)
        expect(secretDenied.stderr).toContain("permission 'read' resolves to ask")
        const secretRead = await tool(ws, "read", { filePath: join(ws.dir, ".env") })
        expect(secretRead.json?.result.output).toContain("READ-CANARY")

        const example = await tool(ws, "read", { filePath: join(ws.dir, ".env.example") }, { skip: false })
        expect(example.code).toBe(0)
        expect(example.json?.result.output).toContain("SAFE=1")

        const externalDenied = await tool(ws, "read", { filePath: outsideFile }, { skip: false })
        expect(externalDenied.code).toBe(1)
        expect(externalDenied.stderr).toContain("external_directory")
        const external = await tool(ws, "read", { filePath: outsideFile })
        expect(external.json?.result.output).toContain("OUTSIDE-CONTENT")
      } finally {
        await rm(outside, { recursive: true, force: true })
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "write and edit change files and glob/grep find them",
    async () => {
      const ws = await workspace("file-write")
      try {
        const slug = await createOperation(ws)
        const written = await tool(ws, "write", {
          filePath: "notes/a.txt",
          content: "first line\nsecond line\n",
        })
        expect(written.code).toBe(0)
        expect(await readFile(join(ws.dir, "notes", "a.txt"), "utf8")).toContain("second line")

        const created = await tool(ws, "edit", {
          filePath: "notes/b.txt",
          oldString: "",
          newString: "SECOND-LINE-EDITED\n",
        })
        expect(created.code).toBe(0)
        const text = await readFile(join(ws.dir, "notes", "b.txt"), "utf8")
        expect(text).toContain("SECOND-LINE-EDITED")

        const glob = await tool(ws, "glob", { pattern: "**/*.txt", path: ws.dir })
        expect(glob.code).toBe(0)
        expect(glob.json?.result.output).toContain(join(ws.dir, "notes", "a.txt"))
        expect(glob.json?.result.output).toContain(join(ws.dir, "notes", "b.txt"))

        const grep = await tool(ws, "grep", { pattern: "SECOND-LINE-EDITED", path: join(ws.dir, "notes") })
        expect(grep.code).toBe(0)
        expect(grep.json?.result.output).toContain("Found 1 matches")
        expect(grep.json?.result.output).toContain("b.txt")

        const noMatch = await tool(ws, "grep", { pattern: "NEVER-PRESENT", path: join(ws.dir, "notes") })
        expect(noMatch.json?.result.output).toBe("No files found")

        // Both edit calls and the write are audited.
        const events = ledger(ws, slug)
        expect(events.filter((event) => event.kind === "tool.completed" && event.source === "write").length).toBe(1)
        expect(events.filter((event) => event.kind === "tool.completed" && event.source === "edit").length).toBe(1)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "an external write asks before leaving the workspace",
    async () => {
      const ws = await workspace("file-external-write")
      const outside = await mkdtemp(join(tmpdir(), "axiomsec-outside-write-"))
      try {
        await createOperation(ws)
        const target = join(outside, "outside.txt")
        const denied = await tool(ws, "write", { filePath: target, content: "OUTSIDE" }, { skip: false })
        expect(denied.code).toBe(1)
        expect(denied.stderr).toContain("external_directory")
        expect(await Bun.file(target).exists()).toBe(false)

        const allowed = await tool(ws, "write", { filePath: target, content: "OUTSIDE" })
        expect(allowed.code).toBe(0)
        expect(await readFile(target, "utf8")).toBe("OUTSIDE")
      } finally {
        await rm(outside, { recursive: true, force: true })
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("bash execution, timeout and truncation", () => {
  test(
    "bash asks by default, runs with the flag, and enforces a timeout",
    async () => {
      const ws = await workspace("bash-run")
      try {
        await createOperation(ws)
        const denied = await tool(
          ws,
          "bash",
          { command: "echo AXIOMSEC-BASH", description: "print a marker" },
          { skip: false },
        )
        expect(denied.code).toBe(1)
        expect(denied.stderr).toContain("permission 'bash' resolves to ask")

        const echo = await tool(ws, "bash", { command: "echo AXIOMSEC-BASH", description: "print a marker" })
        expect(echo.code).toBe(0)
        expect(echo.json?.result.output).toContain("AXIOMSEC-BASH")

        const started = Date.now()
        const timedOut = await tool(ws, "bash", {
          command: 'bun -e "await Bun.sleep(5000)"',
          timeout: 300,
          description: "sleep longer than the timeout",
        })
        expect(Date.now() - started).toBeLessThan(4_000)
        expect(timedOut.code).toBe(0)
        expect(timedOut.json?.result.output).toContain("exceeding timeout 300 ms")
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "large bash output is truncated and the full output is saved",
    async () => {
      const ws = await workspace("bash-truncate")
      try {
        await createOperation(ws)
        const lines = Array.from({ length: 3_000 }, (_, index) => `line-${index + 1}`)
        await writeFile(join(ws.dir, "big.txt"), lines.join("\n") + "\n")

        const result = await tool(ws, "bash", { command: "cat big.txt", description: "print a large file" })
        expect(result.code).toBe(0)
        const metadata = result.json?.result.metadata
        expect(metadata?.truncated).toBe(true)
        expect(metadata?.outputPath).toBeTruthy()
        expect(result.json?.result.output).toContain("output truncated")
        expect(result.json?.result.output).toContain("Full output saved to")
        const saved = await readFile(metadata!.outputPath, "utf8")
        expect(saved).toContain("line-1\n")
        expect(saved).toContain("line-3000")
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("todo writes synchronise the plan", () => {
  test(
    "todowrite stores the list and mirrors it into plan facts",
    async () => {
      const ws = await workspace("todo-plan")
      try {
        const slug = await createOperation(ws)
        const result = await tool(ws, "todowrite", {
          todos: [
            { content: "recon the target", status: "completed", priority: "high" },
            { content: "confirm the finding", status: "in_progress", priority: "medium" },
            { content: "write the report", status: "pending", priority: "low" },
          ],
        })
        expect(result.code).toBe(0)
        expect(result.json?.result.metadata.todos).toHaveLength(3)

        const events = ledger(ws, slug)
        const sync = events.find((event) => event.source === "todowrite" && event.kind === "fact.observed")
        expect(sync).toBeTruthy()
        expect(sync?.data["nodes"]).toBe(3)
        expect(sync?.data["done"]).toBe(1)
        expect(sync?.data["running"]).toBe(1)
        expect(sync?.data["planned"]).toBe(1)

        const plan = await readFile(join(ws.dir, ".axiomsec", "operation", slug, "plan.jsonl"), "utf8")
        expect(plan).toContain("recon the target")
        expect(plan).toContain("write the report")
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})
