import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { binaryPath, ledger, run, workspace, type Workspace } from "../support/harness"
import { mockConfig, mockProvider, parseEvents, textOf } from "../support/provider"

const BIN = binaryPath()
const FIXTURE = join(import.meta.dir, "..", "fixtures", "mcp-echo.ts")

function mcpConfig(baseURL: string) {
  return {
    ...mockConfig(baseURL),
    mcp: {
      echo: {
        type: "local",
        command: [process.execPath, FIXTURE],
        enabled: true,
        timeout: 10_000,
      },
    },
  }
}

async function createOperation(ws: Workspace) {
  const result = await run(ws, ["operation", "new", "MCP", "--kind", "pentest", "--target", "http://127.0.0.1:18080"])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1]!
}

describe.skipIf(!BIN)("MCP tool integration", () => {
  test(
    "an MCP tool is not executed when its permission asks",
    async () => {
      const ws = await workspace("mcp-ask")
      const provider = mockProvider([
        { kind: "tool", call: { name: "echo_echo", arguments: { text: "MCP-CANARY" } } },
        { kind: "text", content: "MCP-DONE" },
      ])
      try {
        const slug = await createOperation(ws)
        const result = await run(ws, ["run", "use the echo tool", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mcpConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.stderr).toContain("permission requested: mcp")
        expect(result.stdout).toContain("rejected permission")
        expect(provider.calls()).toBe(1)
        expect(textOf(parseEvents(result.stdout))).toBe("")

        const events = ledger(ws, slug)
        const called = events.filter((event) => event.kind === "tool.called" && event.source === "echo_echo")
        const completed = events.filter((event) => event.kind === "tool.completed" && event.source === "echo_echo")
        expect(called.length).toBeGreaterThan(0)
        expect(completed).toEqual([])
        expect(JSON.stringify(events)).not.toContain("ECHO:MCP-CANARY")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    180_000,
  )

  test(
    "an explicit mcp deny rule overrides the bypass flag",
    async () => {
      const ws = await workspace("mcp-deny")
      const provider = mockProvider([
        { kind: "tool", call: { name: "echo_echo", arguments: { text: "MCP-DENIED" } } },
        { kind: "text", content: "DENY-ACK" },
      ])
      try {
        const slug = await createOperation(ws)
        const config = { ...mcpConfig(provider.baseURL), permission: { mcp: "deny" } }
        const result = await run(ws, ["run", "use the echo tool", "--format", "json", "--dangerously-skip-permissions"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(config),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("DENY-ACK")
        expect(result.stderr).not.toContain("permission requested: mcp")
        expect(JSON.stringify(provider.transcripts()[1])).toContain("rule which prevents")
        const events = ledger(ws, slug)
        expect(events.some((event) => event.kind === "tool.error" && event.source === "echo_echo")).toBe(true)
        expect(JSON.stringify(events)).not.toContain("ECHO:MCP-DENIED")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "with explicit approval the MCP result reaches the model and the ledger",
    async () => {
      const ws = await workspace("mcp-allow")
      const provider = mockProvider([
        { kind: "tool", call: { name: "echo_echo", arguments: { text: "MCP-CANARY" } } },
        { kind: "text", content: "MCP-DONE" },
      ])
      try {
        const slug = await createOperation(ws)
        const result = await run(
          ws,
          ["run", "use the echo tool", "--format", "json", "--dangerously-skip-permissions"],
          {
            AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mcpConfig(provider.baseURL)),
            MOCK_API_KEY: "mock",
          },
        )
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("MCP-DONE")
        expect(result.stderr).not.toContain("permission requested: mcp")
        expect(provider.calls()).toBe(2)

        const second = JSON.stringify(provider.transcripts()[1])
        expect(second).toContain("ECHO:MCP-CANARY")

        const events = ledger(ws, slug)
        expect(
          events.some((event) => event.kind === "tool.completed" && event.source === "echo_echo"),
        ).toBe(true)
        expect(events.some((event) => event.kind === "tool.error" && event.source === "echo_echo")).toBe(false)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    180_000,
  )

  test(
    "a stored provider key is not exported to the MCP server",
    async () => {
      const ws = await workspace("mcp-env")
      const provider = mockProvider([
        { kind: "tool", call: { name: "echo_env", arguments: { name: "AICORE_SERVICE_KEY" } } },
        { kind: "text", content: "ENV-DONE" },
      ])
      const canary = "MCP-AUTH-CANARY-9a2f"
      try {
        await createOperation(ws)
        const authFile = join(ws.env.XDG_DATA_HOME, "axiomsec", "auth.json")
        await mkdir(dirname(authFile), { recursive: true })
        await writeFile(authFile, JSON.stringify({ "sap-ai-core": { type: "api", key: canary } }))
        const result = await run(
          ws,
          ["run", "inspect the MCP environment", "--format", "json", "--dangerously-skip-permissions"],
          {
            AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mcpConfig(provider.baseURL)),
            MOCK_API_KEY: "mock",
          },
        )
        expect(result.code).toBe(0)
        const second = JSON.stringify(provider.transcripts()[1])
        expect(second).toContain("ENV:UNSET")
        expect(second).not.toContain(canary)
        expect(result.stdout + result.stderr).not.toContain(canary)
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )
})
