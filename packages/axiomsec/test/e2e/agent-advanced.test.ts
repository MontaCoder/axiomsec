import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { binaryPath, facts, ledger, readDb, run, workspace } from "../support/harness"
import { mockConfig, mockProvider, parseEvents, textOf } from "../support/provider"

const BIN = binaryPath()

async function createOperation(ws: Awaited<ReturnType<typeof workspace>>, target: string) {
  const result = await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", target])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1] ?? "verify"
}

function toolNames(request: Record<string, unknown>): string[] {
  const tools = request["tools"]
  if (!Array.isArray(tools)) return []
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return ""
    const item = tool as Record<string, unknown>
    if (typeof item["name"] === "string") return item["name"]
    const fn = item["function"]
    if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>)["name"] === "string") {
      return (fn as Record<string, unknown>)["name"] as string
    }
    return ""
  }).filter(Boolean)
}

describe.skipIf(!BIN)("real agent loop breadth", () => {
  test(
    "the model receives the operation context and only permitted tools",
    async () => {
      const ws = await workspace("e2e-tools")
      const provider = mockProvider([{ kind: "text", content: "TOOLS-SEEN" }])
      try {
        await createOperation(ws, "http://127.0.0.1:18080")
        const config = { ...mockConfig(provider.baseURL), permission: { bash: "deny" } }
        const result = await run(ws, ["run", "inspect your tools", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(config),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("TOOLS-SEEN")

        const first = provider.requests()[0]
        const names = toolNames(first)
        expect(names).toContain("scope")
        expect(names).toContain("http_request")
        expect(names).toContain("finding")
        // A deny rule removes the tool before the model ever sees it.
        expect(names).not.toContain("bash")

        const context = JSON.stringify(provider.transcripts()[0])
        expect(context).toContain("Verify")
        expect(context).toContain("127.0.0.1")
        expect(context).toContain("pentest")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "a specialist lane removes its out-of-lane tools from the model request",
    async () => {
      const ws = await workspace("e2e-lane")
      const provider = mockProvider([{ kind: "text", content: "OSINT-READY" }])
      try {
        await createOperation(ws, "http://127.0.0.1:18080")
        const result = await run(ws, ["run", "who are you", "--agent", "osint", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("OSINT-READY")
        const names = toolNames(provider.requests()[0])
        expect(names).toContain("http_request")
        expect(names).toContain("webfetch")
        for (const hidden of ["scanner", "appsec_probe", "binary_triage", "cloud_posture", "net", "crypto"]) {
          expect(names).not.toContain(hidden)
        }
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "two tool calls in one run are both executed and the final answer is streamed",
    async () => {
      const ws = await workspace("e2e-multi-tool")
      const provider = mockProvider([
        { kind: "tool", call: { name: "scope", arguments: { action: "status" } } },
        { kind: "tool", call: { name: "evidence", arguments: { action: "add_text", text: "MULTI-TOOL-EVIDENCE", label: "multi" } } },
        { kind: "text", content: "AFTER-MULTI-TOOLS" },
      ])
      try {
        const slug = await createOperation(ws, "http://127.0.0.1:18080")
        const result = await run(ws, ["run", "do two things", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("AFTER-MULTI-TOOLS")
        expect(provider.calls()).toBe(3)

        const events = ledger(ws, slug)
        for (const tool of ["scope", "evidence"]) {
          expect(events.some((event) => event.kind === "tool.called" && event.source === tool)).toBe(true)
          expect(events.some((event) => event.kind === "tool.completed" && event.source === tool)).toBe(true)
        }
        const evidence = events.filter((event) => event.kind === "evidence.added")
        expect(evidence.length).toBeGreaterThan(0)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "the run loop auto-rejects an ask and does not touch the target",
    async () => {
      const ws = await workspace("e2e-reject")
      let hits = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          hits += 1
          return new Response("SHOULD-NOT-BE-HIT")
        },
      })
      const provider = mockProvider([
        {
          kind: "tool",
          call: { name: "http_request", arguments: { url: `http://127.0.0.1:${server.port}/guarded` } },
        },
        { kind: "text", content: "REJECTED-ACK" },
      ])
      try {
        const slug = await createOperation(ws, `http://127.0.0.1:${server.port}`)
        const result = await run(ws, ["run", "fetch the guarded URL", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        // A rejected permission ends this prompt: the tool fails closed and the
        // model is not asked to continue. The target is never touched.
        expect(textOf(parseEvents(result.stdout))).toBe("")
        expect(provider.calls()).toBe(1)
        expect(hits).toBe(0)
        expect(result.stderr).toContain("permission requested: http_request")
        expect(result.stdout).toContain("The user rejected permission")

        const events = ledger(ws, slug)
        expect(events.some((event) => event.kind === "tool.error" && event.source === "http_request")).toBe(true)
        expect(events.some((event) => event.kind === "tool.completed" && event.source === "http_request")).toBe(false)
        // The tool call is still recorded and the operation is intact.
        expect(events.some((event) => event.kind === "tool.called" && event.source === "http_request")).toBe(true)
        expect(facts(ws, slug).length).toBeGreaterThan(0)
      } finally {
        provider.close()
        server.stop(true)
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "read, write and edit work together in one session",
    async () => {
      const ws = await workspace("e2e-file-chain")
      const provider = mockProvider([
        { kind: "tool", call: { name: "read", arguments: { filePath: join(ws.dir, "a.txt") } } },
        { kind: "tool", call: { name: "write", arguments: { filePath: "b.txt", content: "BETA-FILE\n" } } },
        {
          kind: "tool",
          call: {
            name: "edit",
            arguments: { filePath: "a.txt", oldString: "second line", newString: "SECOND-EDITED" },
          },
        },
        { kind: "text", content: "FILE-TOOLS-OK" },
      ])
      try {
        const slug = await createOperation(ws, "http://127.0.0.1:18080")
        await Bun.write(join(ws.dir, "a.txt"), "first line\nsecond line\n")
        const result = await run(ws, ["run", "read, write and edit", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("FILE-TOOLS-OK")
        expect(provider.calls()).toBe(4)

        const a = await readFile(join(ws.dir, "a.txt"), "utf8")
        expect(a).toContain("SECOND-EDITED")
        expect(a).not.toContain("second line")
        const b = await readFile(join(ws.dir, "b.txt"), "utf8")
        expect(b).toBe("BETA-FILE\n")

        const events = ledger(ws, slug)
        for (const tool of ["read", "write", "edit"]) {
          expect(events.some((event) => event.kind === "tool.completed" && event.source === tool)).toBe(true)
        }
        expect(events.some((event) => event.kind === "tool.error")).toBe(false)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "a vault secret is redacted in the persisted transcript and ledger (RISK-SECRET-05)",
    async () => {
      const ws = await workspace("e2e-vault-redaction")
      const canary = "SESSION-VAULT-CANARY-9f2c"
      const provider = mockProvider([
        { kind: "tool", call: { name: "vault", arguments: { action: "set", key: "session-canary", value: canary } } },
        { kind: "text", content: "VAULT-STORED" },
      ])
      try {
        const slug = await createOperation(ws, "http://127.0.0.1:18080")
        const result = await run(ws, ["run", "store the canary", "--format", "json", "--dangerously-skip-permissions"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("VAULT-STORED")
        expect(result.stdout).not.toContain(canary)

        const db = readDb(ws)
        try {
          const parts = db.query("SELECT data FROM part").all() as Array<{ data: string }>
          const serialized = parts.map((row) => row.data).join("\n")
          expect(serialized).toContain("[redacted:secret:value]")
          expect(serialized).not.toContain(canary)
        } finally {
          db.close()
        }

        const events = ledger(ws, slug)
        expect(JSON.stringify(events)).not.toContain(canary)
        const called = events.find((event) => event.kind === "tool.called" && event.source === "vault")
        expect(called?.data["input"]).toMatchObject({ action: "set", key: "session-canary" })
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "a subagent task gets its own session and the result returns to the main agent",
    async () => {
      const ws = await workspace("e2e-subagent")
      const provider = mockProvider([
        {
          kind: "tool",
          call: {
            name: "task",
            arguments: {
              description: "look around",
              prompt: "Inspect the workspace and report one line.",
              subagent_type: "general",
            },
          },
        },
        { kind: "text", content: "SUBAGENT-ANSWER" },
        { kind: "text", content: "MAIN-ANSWER" },
      ])
      try {
        const slug = await createOperation(ws, "http://127.0.0.1:18080")
        const result = await run(ws, ["run", "delegate this", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("MAIN-ANSWER")
        expect(provider.calls()).toBe(3)
        expect(ledger(ws, slug).some((event) => event.kind === "tool.completed" && event.source === "task")).toBe(true)

        const db = readDb(ws)
        try {
          const sessions = db.query("SELECT id, parent_id FROM session ORDER BY time_created").all() as Array<{
            id: string
            parent_id: string | null
          }>
          expect(sessions).toHaveLength(2)
          const child = sessions.find((session) => session.parent_id !== null)
          expect(child).toBeTruthy()
          expect(sessions.some((session) => session.id === child?.parent_id)).toBe(true)
        } finally {
          db.close()
        }

        // The subagent's answer is visible to the parent model, not printed as
        // top-level text; the main answer is the final output.
        expect(JSON.stringify(provider.transcripts()[2])).toContain("SUBAGENT-ANSWER")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    180_000,
  )

  test(
    "a subagent permission ask is rejected instead of hanging the headless run",
    async () => {
      const ws = await workspace("e2e-subagent-ask")
      const provider = mockProvider([
        {
          kind: "tool",
          call: {
            name: "task",
            arguments: {
              description: "run a shell command",
              prompt: "Run the shell command `echo CHILD`. Then report back.",
              subagent_type: "general",
            },
          },
        },
        { kind: "tool", call: { name: "bash", arguments: { command: "echo CHILD", description: "child shell" } } },
        { kind: "text", content: "MAIN-AFTER-CHILD" },
      ])
      try {
        const slug = await createOperation(ws, "http://127.0.0.1:18080")
        const result = await run(ws, ["run", "delegate a shell command", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("MAIN-AFTER-CHILD")
        expect(result.stderr).toContain("permission requested: bash")
        // The child ask was auto-rejected; the shell never ran.
        expect(JSON.stringify(provider.transcripts())).not.toContain("CHILD\n")
        const events = ledger(ws, slug)
        expect(events.some((event) => event.kind === "tool.error" && event.source === "bash")).toBe(true)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "a subagent inherits the parent run's deny rules",
    async () => {
      const ws = await workspace("e2e-subagent-deny")
      const provider = mockProvider([
        {
          kind: "tool",
          call: {
            name: "task",
            arguments: {
              description: "ask the operator",
              prompt: "Ask the operator whether to proceed.",
              subagent_type: "pentest",
            },
          },
        },
        {
          kind: "tool",
          call: {
            name: "question",
            arguments: {
              questions: [
                {
                  question: "Proceed?",
                  header: "Go",
                  options: [{ label: "Yes", description: "Proceed" }],
                },
              ],
            },
          },
        },
        { kind: "text", content: "MAIN-AFTER-QUESTION" },
      ])
      try {
        const slug = await createOperation(ws, "http://127.0.0.1:18080")
        const result = await run(ws, ["run", "delegate a question", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("MAIN-AFTER-QUESTION")
        // The parent run denies question; the pentest subagent must not
        // re-enable it and block the headless loop.
        expect(result.stderr).not.toContain("permission requested: question")
        // The inherited deny removes question from the child's tool surface;
        // the forced call falls through to the invalid-tool handler.
        expect(toolNames(provider.requests()[1])).not.toContain("question")
        const events = ledger(ws, slug)
        expect(events.some((event) => event.source === "question")).toBe(false)
        expect(events.some((event) => event.source === "invalid")).toBe(true)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "the apply_patch editor adds and updates a file for a gpt-family model",
    async () => {
      const ws = await workspace("e2e-apply-patch")
      const provider = mockProvider([
        {
          kind: "tool",
          call: {
            name: "apply_patch",
            arguments: {
              patchText: ["*** Begin Patch", "*** Add File: notes/patch.txt", "+line one", "*** End Patch"].join("\n"),
            },
          },
        },
        {
          kind: "tool",
          call: {
            name: "apply_patch",
            arguments: {
              patchText: [
                "*** Begin Patch",
                "*** Update File: notes/patch.txt",
                "@@",
                "-line one",
                "+line two",
                "*** End Patch",
              ].join("\n"),
            },
          },
        },
        { kind: "text", content: "PATCH-DONE" },
      ])
      try {
        const slug = await createOperation(ws, "http://127.0.0.1:18080")
        const base = mockConfig(provider.baseURL)
        const config = {
          ...base,
          model: "mock/gpt-5-test",
          provider: {
            mock: {
              ...base.provider.mock,
              models: {
                ...base.provider.mock.models,
                "gpt-5-test": {
                  name: "GPT test",
                  tool_call: true,
                  limit: { context: 8192, output: 1024 },
                  cost: { input: 0, output: 0 },
                },
              },
            },
          },
        }
        const result = await run(ws, ["run", "patch the file", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(config),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("PATCH-DONE")
        expect(provider.calls()).toBe(3)
        expect(toolNames(provider.requests()[0])).toContain("apply_patch")
        expect(toolNames(provider.requests()[0])).not.toContain("write")
        expect(await readFile(join(ws.dir, "notes", "patch.txt"), "utf8")).toBe("line two\n")

        const events = ledger(ws, slug)
        expect(events.filter((event) => event.kind === "tool.completed" && event.source === "apply_patch")).toHaveLength(2)
        expect(events.some((event) => event.kind === "tool.error")).toBe(false)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "the model cannot self-elevate autonomy without approval",
    async () => {
      const ws = await workspace("e2e-autonomy")
      const provider = mockProvider([
        { kind: "tool", call: { name: "autonomy", arguments: { action: "set", mode: "auto" } } },
        { kind: "tool", call: { name: "bash", arguments: { command: "echo ELEVATED", description: "elevated" } } },
        { kind: "text", content: "ELEVATION-SUCCEEDED" },
      ])
      try {
        const slug = await createOperation(ws, "http://127.0.0.1:18080")
        const result = await run(ws, ["run", "become autonomous", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.stderr).toContain("permission requested: autonomy")
        expect(provider.calls()).toBe(1)
        expect(textOf(parseEvents(result.stdout))).toBe("")
        const events = ledger(ws, slug)
        expect(events.some((event) => event.kind === "tool.error" && event.source === "autonomy")).toBe(true)
        expect(events.some((event) => event.source === "bash")).toBe(false)
        expect(events.some((event) => event.kind === "tool.completed" && event.source === "autonomy")).toBe(false)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "a permanent provider quota error fails the run with a non-zero exit code",
    async () => {
      const ws = await workspace("e2e-quota")
      const provider = mockProvider([
        {
          kind: "error",
          status: 429,
          message: "Rate limit exceeded: free-models-per-day",
          body: JSON.stringify({
            error: {
              message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
              code: 429,
              metadata: { limit_source: "openrouter_free_tier_daily" },
            },
          }),
        },
      ])
      try {
        await createOperation(ws, "http://127.0.0.1:18080")
        const result = await run(ws, ["run", "answer me", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        const events = parseEvents(result.stdout)
        expect(result.code).toBe(1)
        expect(events.some((event) => event.type === "error")).toBe(true)
        expect(textOf(events)).toBe("")
        // A daily quota is permanent; it must not be retried.
        expect(provider.calls()).toBe(1)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "a transient provider failure is retried and then succeeds",
    async () => {
      const ws = await workspace("e2e-retry")
      const provider = mockProvider([
        { kind: "error", status: 503, message: "temporarily unavailable" },
        { kind: "text", content: "RECOVERED-AFTER-RETRY" },
      ])
      try {
        await createOperation(ws, "http://127.0.0.1:18080")
        const result = await run(ws, ["run", "answer me", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("RECOVERED-AFTER-RETRY")
        expect(provider.calls()).toBe(2)
        expect(result.stdout).not.toContain('"type":"error"')
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "the explicit bypass flag approves the same request end to end",
    async () => {
      const ws = await workspace("e2e-approve")
      let hits = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          hits += 1
          return new Response("APPROVED-BODY", { headers: { "content-type": "text/plain" } })
        },
      })
      const provider = mockProvider([
        {
          kind: "tool",
          call: { name: "http_request", arguments: { url: `http://127.0.0.1:${server.port}/approved` } },
        },
        { kind: "text", content: "APPROVED-ACK" },
      ])
      try {
        await createOperation(ws, `http://127.0.0.1:${server.port}`)
        const result = await run(ws, ["run", "fetch the URL", "--format", "json", "--dangerously-skip-permissions"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("APPROVED-ACK")
        expect(hits).toBe(1)
        expect(result.stderr).toContain("DANGER: --dangerously-skip-permissions")
        // The in-scope target does not need a scope approval; the tool-level ask does.
        expect(result.stderr).not.toContain("permission requested:")

        // The second model turn sees the tool result with the body preview.
        const second = JSON.stringify(provider.transcripts()[1])
        expect(second).toContain("APPROVED-BODY")
        expect(second).toContain("HTTP 200")
      } finally {
        provider.close()
        server.stop(true)
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("provider credentials in subprocesses", () => {
  test(
    "a stored provider key is not exported to the bash tool",
    async () => {
      const ws = await workspace("e2e-auth-env")
      const provider = mockProvider([
        {
          kind: "tool",
          call: {
            name: "bash",
            arguments: { command: "printenv AICORE_SERVICE_KEY", description: "read provider env" },
          },
        },
        { kind: "text", content: "ENV-INSPECTED" },
      ])
      const canary = "SAP-AUTH-CANARY-31c7"
      try {
        await createOperation(ws, "http://127.0.0.1:18080")
        const authFile = join(ws.env.XDG_DATA_HOME, "axiomsec", "auth.json")
        await mkdir(dirname(authFile), { recursive: true })
        await writeFile(authFile, JSON.stringify({ "sap-ai-core": { type: "api", key: canary } }))
        const result = await run(ws, ["run", "inspect the environment", "--format", "json", "--dangerously-skip-permissions"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("ENV-INSPECTED")
        expect(provider.calls()).toBe(2)
        expect(JSON.stringify(provider.transcripts())).not.toContain(canary)
        expect(result.stdout + result.stderr).not.toContain(canary)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )
})
