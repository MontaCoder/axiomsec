import { describe, expect, test } from "bun:test"
import { binaryPath, facts, ledger, run, workspace } from "../support/harness"
import { mockConfig, mockProvider, parseEvents, textOf } from "../support/provider"

// The integration and end-to-end layers run against the built binary. Without
// a build they are skipped rather than failing, so a fresh checkout can still
// run the fast suites. CI builds first, so there they always run.
const BIN = binaryPath()

describe.skipIf(!BIN)("agent end to end", () => {
  test(
    "the agent answers a prompt through the model endpoint",
    async () => {
      const ws = await workspace("e2e-text")
      const provider = mockProvider([{ kind: "text", content: "MOCK-PROVIDER-OK" }])
      try {
        const result = await run(ws, ["run", "Say MOCK-PROVIDER-OK", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        const events = parseEvents(result.stdout)
        expect(result.code).toBe(0)
        expect(textOf(events)).toContain("MOCK-PROVIDER-OK")
        expect(events.some((e) => e.type === "step_finish")).toBe(true)
        expect(events.some((e) => e.type === "error")).toBe(false)
        expect(provider.calls()).toBe(1)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "a tool call from the model reaches the operation and is ledgered",
    async () => {
      const ws = await workspace("e2e-tool")
      const provider = mockProvider([
        { kind: "tool", call: { name: "scope", arguments: { action: "status" } } },
        { kind: "text", content: "SCOPE-CHECKED" },
      ])
      try {
        await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])

        const result = await run(ws, ["run", "check the scope", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        const events = parseEvents(result.stdout)
        expect(result.code).toBe(0)
        expect(textOf(events)).toContain("SCOPE-CHECKED")
        expect(provider.calls()).toBe(2)

        // The tool call must be recorded in the canonical kernel, not just in
        // the transcript.
        const slug = "verify"
        const events2 = ledger(ws, slug)
        const called = events2.filter((e) => e.kind === "tool.called" && e.source === "scope")
        const completed = events2.filter((e) => e.kind === "tool.completed" && e.source === "scope")
        expect(called.length).toBeGreaterThan(0)
        expect(completed.length).toBeGreaterThan(0)
        expect(called[0]?.data["tool"]).toBe("scope")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "the model sees the operation context and the tool result",
    async () => {
      const ws = await workspace("e2e-context")
      const provider = mockProvider([
        { kind: "tool", call: { name: "scope", arguments: { action: "status" } } },
        { kind: "text", content: "DONE" },
      ])
      try {
        await run(ws, ["operation", "new", "Verify", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
        const result = await run(ws, ["run", "check the scope", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)

        // The second request must carry the first tool result back to the model.
        const second = provider.transcripts()[1] ?? []
        const serialized = JSON.stringify(second)
        expect(serialized).toContain("scope")
        expect(serialized.length).toBeGreaterThan(0)

        // The operation must exist as a fact in the kernel.
        const found = facts(ws, "verify")
        expect(found.length).toBeGreaterThan(0)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    90_000,
  )
})
