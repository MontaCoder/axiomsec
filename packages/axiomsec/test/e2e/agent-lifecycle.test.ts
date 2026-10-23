import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { isRecord } from "../../src/support/record"
import { binaryPath, ledger, readDb, run, workspace, type Workspace } from "../support/harness"
import { mockConfig, mockProvider, parseEvents, textOf, type MockProvider } from "../support/provider"

const BIN = binaryPath()

function errorText(event: Record<string, unknown>): string {
  if (isRecord(event.error) && isRecord(event.error.data) && typeof event.error.data.message === "string") {
    return event.error.data.message
  }
  return ""
}

type SessionRow = { id: string; title: string; parent_id: string | null }

function sessions(ws: Workspace): SessionRow[] {
  const db = readDb(ws)
  try {
    return db.query<SessionRow, []>("SELECT id, title, parent_id FROM session ORDER BY time_created").all()
  } finally {
    db.close()
  }
}

async function createOperation(ws: Workspace, target = "http://127.0.0.1:18080"): Promise<string> {
  const result = await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", target])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1] ?? "verify"
}

function envFor(provider: MockProvider, extra?: Record<string, string>): Record<string, string> {
  return { AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)), MOCK_API_KEY: "mock", ...extra }
}

describe.skipIf(!BIN)("agent session lifecycle", () => {
  test(
    "an explicit title is stored on the session",
    async () => {
      const ws = await workspace("life-title")
      const provider = mockProvider([{ kind: "text", content: "TITLED-ANSWER" }])
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "hello", "--title", "My Custom Title", "--format", "json"], envFor(provider))
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("TITLED-ANSWER")
        const rows = sessions(ws)
        expect(rows).toHaveLength(1)
        expect(rows[0].title).toBe("My Custom Title")
        expect(rows[0].parent_id).toBeNull()
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "an empty --title derives a truncated prompt title",
    async () => {
      const ws = await workspace("life-title-derived")
      const provider = mockProvider([{ kind: "text", content: "OK" }])
      try {
        await createOperation(ws)
        const prompt = "A".repeat(80)
        const result = await run(ws, ["run", prompt, "--title", "", "--format", "json"], envFor(provider))
        expect(result.code).toBe(0)
        expect(sessions(ws)[0].title).toBe(`${"A".repeat(50)}...`)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "--continue reuses the most recent root session and keeps its context",
    async () => {
      const ws = await workspace("life-continue")
      const provider = mockProvider([{ kind: "text", content: "FIRST-ANSWER" }])
      try {
        await createOperation(ws)
        const first = await run(ws, ["run", "FIRST-QUESTION", "--format", "json"], envFor(provider))
        expect(first.code).toBe(0)
        const second = await run(ws, ["run", "SECOND-QUESTION", "--continue", "--format", "json"], envFor(provider))
        expect(second.code).toBe(0)
        expect(provider.calls()).toBe(2)

        const rows = sessions(ws)
        expect(rows).toHaveLength(1)
        expect(rows[0].parent_id).toBeNull()

        // The second model request must contain the first turn.
        const transcript = JSON.stringify(provider.transcripts()[1])
        expect(transcript).toContain("FIRST-QUESTION")
        expect(transcript).toContain("FIRST-ANSWER")
        expect(transcript).toContain("SECOND-QUESTION")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "--session resumes a specific session by id",
    async () => {
      const ws = await workspace("life-session")
      const provider = mockProvider([{ kind: "text", content: "SESSION-ANSWER" }])
      try {
        await createOperation(ws)
        expect((await run(ws, ["run", "one", "--format", "json"], envFor(provider))).code).toBe(0)
        const id = sessions(ws)[0].id
        const resumed = await run(ws, ["run", "two", "--session", id, "--format", "json"], envFor(provider))
        expect(resumed.code).toBe(0)
        expect(provider.calls()).toBe(2)
        expect(sessions(ws)).toHaveLength(1)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "--fork creates a child session linked to the continued root",
    async () => {
      const ws = await workspace("life-fork")
      const provider = mockProvider([{ kind: "text", content: "FORKED-ANSWER" }])
      try {
        await createOperation(ws)
        expect((await run(ws, ["run", "root prompt", "--format", "json"], envFor(provider))).code).toBe(0)
        const forked = await run(ws, ["run", "forked prompt", "--continue", "--fork", "--format", "json"], envFor(provider))
        expect(forked.code).toBe(0)

        const rows = sessions(ws)
        expect(rows).toHaveLength(2)
        const root = rows.find((row) => row.parent_id === null)!
        const child = rows.find((row) => row.parent_id !== null)!
        expect(child.parent_id).toBe(root.id)
        expect(child.title).toContain("fork #1")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "--fork without --continue or --session is rejected before any model call",
    async () => {
      const ws = await workspace("life-fork-invalid")
      const provider = mockProvider([{ kind: "text", content: "SHOULD-NOT-RUN" }])
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "hello", "--fork", "--format", "json"], envFor(provider))
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("--fork requires --continue or --session")
        expect(provider.calls()).toBe(0)
        expect(sessions(ws)).toHaveLength(0)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "an unknown --session fails the run cleanly (RISK-CLI-06)",
    async () => {
      const ws = await workspace("life-session-missing")
      const provider = mockProvider([{ kind: "text", content: "SHOULD-NOT-RUN" }])
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "hello", "--session", "ses_doesnotexist", "--format", "json"], envFor(provider))
        expect(result.code).toBe(1)
        const events = parseEvents(result.stdout)
        const error = events.find((event) => event.type === "error")
        expect(error).toBeTruthy()
        expect(JSON.stringify(error)).toContain("Session not found: ses_doesnotexist")
        // The failure must be reported, not dumped as a bundled-source excerpt.
        expect(result.stderr).not.toContain("B:/~BUN")
        expect(result.stderr).not.toContain("NotFoundError: NotFoundError")
        expect(provider.calls()).toBe(0)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "--file validation rejects a missing path before the model runs",
    async () => {
      const ws = await workspace("life-file-missing")
      const provider = mockProvider([{ kind: "text", content: "SHOULD-NOT-RUN" }])
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "hello", "--file", "nope.txt", "--format", "json"], envFor(provider))
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("File not found: nope.txt")
        expect(provider.calls()).toBe(0)
        expect(sessions(ws)).toHaveLength(0)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "--file attaches the file content for the model",
    async () => {
      const ws = await workspace("life-file")
      const provider = mockProvider([{ kind: "text", content: "FILE-SEEN" }])
      try {
        await createOperation(ws)
        await Bun.write(join(ws.dir, "note.txt"), "ATTACHED-CONTENT-42")
        const result = await run(ws, ["run", "read the attachment", "--file", "note.txt", "--format", "json"], envFor(provider))
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("FILE-SEEN")
        const transcript = JSON.stringify(provider.transcripts()[0])
        expect(transcript).toContain("ATTACHED-CONTENT-42")
        expect(transcript).toContain("note.txt")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "an unknown --agent warns and falls back to the default agent",
    async () => {
      const ws = await workspace("life-agent-unknown")
      const provider = mockProvider([{ kind: "text", content: "FALLBACK-ANSWER" }])
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "hello", "--agent", "nope", "--format", "json"], envFor(provider))
        expect(result.code).toBe(0)
        expect(result.stderr).toContain('agent "nope" not found. Falling back to default agent')
        expect(textOf(parseEvents(result.stdout))).toContain("FALLBACK-ANSWER")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "an unknown --model fails the run with an error event",
    async () => {
      const ws = await workspace("life-model-unknown")
      const provider = mockProvider([{ kind: "text", content: "SHOULD-NOT-RUN" }])
      try {
        await createOperation(ws)
        const result = await run(
          ws,
          ["run", "hello", "--model", "mock/no-such-model", "--format", "json"],
          envFor(provider),
        )
        expect(result.code).toBe(1)
        const events = parseEvents(result.stdout)
        expect(events.some((event) => event.type === "error")).toBe(true)
        expect(result.stdout).toMatch(/no-such-model|not found/i)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "an unknown --command fails the run before the model is called",
    async () => {
      const ws = await workspace("life-command-unknown")
      const provider = mockProvider([{ kind: "text", content: "SHOULD-NOT-RUN" }])
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "--command", "nosuch", "--format", "json"], envFor(provider))
        expect(result.code).toBe(1)
        expect(provider.calls()).toBe(0)
        const events = parseEvents(result.stdout)
        const errors = events.filter((event) => event.type === "error")
        expect(errors.length).toBeGreaterThan(0)
        const messages = errors.map(errorText).filter((message) => message.includes('Command not found: "nosuch"'))
        // The session error and the rejected request carry the same text; it
        // must be reported once, not twice.
        expect(messages).toHaveLength(1)
        expect(sessions(ws)).toHaveLength(1)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "--command runs a built-in command template through the agent",
    async () => {
      const ws = await workspace("life-command")
      const provider = mockProvider([{ kind: "text", content: "COMMAND-ANSWER" }])
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "--command", "doctor", "--format", "json"], envFor(provider))
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("COMMAND-ANSWER")
        expect(provider.calls()).toBe(1)
        expect(sessions(ws)).toHaveLength(1)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )
})

describe.skipIf(!BIN)("provider and tool failure handling", () => {
  test(
    "a provider authentication failure is permanent and fails the run",
    async () => {
      const ws = await workspace("failure-401")
      const provider = mockProvider([{ kind: "error", status: 401, message: "invalid api key" }])
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "hello", "--format", "json"], envFor(provider))
        expect(result.code).toBe(1)
        expect(provider.calls()).toBe(1)
        expect(parseEvents(result.stdout).some((event) => event.type === "error")).toBe(true)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "an empty stream from the provider fails the run instead of hanging",
    async () => {
      const ws = await workspace("failure-empty")
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response("", { headers: { "content-type": "text/event-stream" } })
        },
      })
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "hello", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(`http://127.0.0.1:${server.port}/v1`)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(1)
        expect(parseEvents(result.stdout).some((event) => event.type === "error")).toBe(true)
      } finally {
        await server.stop(true)
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "an unavailable tool is converted to an invalid call and the agent recovers",
    async () => {
      const ws = await workspace("failure-unknown-tool")
      const provider = mockProvider([
        { kind: "tool", call: { name: "totally_made_up", arguments: { a: 1 } } },
        { kind: "text", content: "RECOVERED-AFTER-UNKNOWN" },
      ])
      try {
        const slug = await createOperation(ws)
        const result = await run(ws, ["run", "call a made up tool", "--format", "json"], envFor(provider))
        expect(result.code).toBe(0)
        expect(provider.calls()).toBe(2)
        expect(textOf(parseEvents(result.stdout))).toContain("RECOVERED-AFTER-UNKNOWN")

        const events = ledger(ws, slug)
        expect(events.some((event) => event.kind === "tool.called" && event.source === "invalid")).toBe(true)
        expect(events.some((event) => event.kind === "tool.completed" && event.source === "invalid")).toBe(true)
        // The unavailable name is preserved in the recorded input for audit.
        const called = events.find((event) => event.kind === "tool.called" && event.source === "invalid")!
        expect(JSON.stringify(called.data)).toContain("totally_made_up")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "invalid tool arguments are recorded as a tool error and the agent recovers",
    async () => {
      const ws = await workspace("failure-bad-args")
      const provider = mockProvider([
        { kind: "tool", call: { name: "scope", arguments: { action: "bogus" } } },
        { kind: "text", content: "RECOVERED-AFTER-BAD-ARGS" },
      ])
      try {
        const slug = await createOperation(ws)
        const result = await run(ws, ["run", "call scope badly", "--format", "json"], envFor(provider))
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("RECOVERED-AFTER-BAD-ARGS")

        const events = ledger(ws, slug)
        expect(events.some((event) => event.kind === "tool.called" && event.source === "scope")).toBe(true)
        const failed = events.find((event) => event.kind === "tool.error" && event.source === "scope")
        expect(failed).toBeTruthy()
        expect(failed!.data["reason"]).toBe("invalid arguments")
        expect(events.some((event) => event.kind === "tool.completed" && event.source === "scope")).toBe(false)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "a tool that throws is surfaced to the model and the run continues",
    async () => {
      const ws = await workspace("failure-tool-error")
      const provider = mockProvider([
        { kind: "tool", call: { name: "read", arguments: { filePath: "does-not-exist.txt" } } },
        { kind: "text", content: "RECOVERED-AFTER-TOOL-ERROR" },
      ])
      try {
        const slug = await createOperation(ws)
        const result = await run(ws, ["run", "read a missing file", "--format", "json"], envFor(provider))
        expect(result.code).toBe(0)
        expect(provider.calls()).toBe(2)
        expect(textOf(parseEvents(result.stdout))).toContain("RECOVERED-AFTER-TOOL-ERROR")

        const events = ledger(ws, slug)
        expect(events.some((event) => event.kind === "tool.error" && event.source === "read")).toBe(true)
        expect(events.some((event) => event.kind === "tool.completed" && event.source === "read")).toBe(false)

        // The follow-up request carries the failure back to the model.
        const second = JSON.stringify(provider.transcripts()[1])
        expect(second).toContain("does-not-exist.txt")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )
})
