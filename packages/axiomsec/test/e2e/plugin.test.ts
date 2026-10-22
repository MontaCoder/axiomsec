import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { binaryPath, ledger, run, workspace, type Workspace } from "../support/harness"
import { mockConfig, mockProvider, parseEvents, textOf } from "../support/provider"

const BIN = binaryPath()
const FIXTURE = join(import.meta.dir, "..", "fixtures", "plugin-echo.ts")

function pluginConfig(baseURL: string) {
  return {
    ...mockConfig(baseURL),
    plugin: [pathToFileURL(FIXTURE).href],
  }
}

async function createOperation(ws: Workspace) {
  const result = await run(ws, ["operation", "new", "Plugin", "--kind", "appsec", "--target", "http://127.0.0.1:18080"])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1]!
}

function requestToolNames(request: Record<string, unknown> | undefined) {
  const tools = request?.["tools"]
  if (!Array.isArray(tools)) return []
  return tools.map((tool) => {
    const item = tool as Record<string, unknown>
    const fn = item["function"] as Record<string, unknown> | undefined
    return typeof item["name"] === "string" ? item["name"] : typeof fn?.["name"] === "string" ? fn["name"] : ""
  })
}

describe.skipIf(!BIN)("plugin tools", () => {
  test(
    "a plugin tool runs through the audit wrapper and its result reaches the model",
    async () => {
      const ws = await workspace("plugin-echo")
      const provider = mockProvider([
        { kind: "tool", call: { name: "plugin_echo", arguments: { text: "PLUGIN-CANARY" } } },
        { kind: "text", content: "PLUGIN-DONE" },
      ])
      try {
        const slug = await createOperation(ws)
        const result = await run(ws, ["run", "call the plugin", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(pluginConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("PLUGIN-DONE")
        expect(provider.calls()).toBe(2)
        expect(requestToolNames(provider.requests()[0])).toContain("plugin_echo")
        expect(JSON.stringify(provider.transcripts()[1])).toContain("PLUGIN:PLUGIN-CANARY")

        const events = ledger(ws, slug)
        const called = events.filter((event) => event.kind === "tool.called" && event.source === "plugin_echo")
        const completed = events.filter((event) => event.kind === "tool.completed" && event.source === "plugin_echo")
        expect(called).toHaveLength(1)
        expect(completed).toHaveLength(1)
        expect(called[0]?.data["input"]).toMatchObject({ text: "PLUGIN-CANARY" })
        expect(completed[0]?.data["metadata"]).toMatchObject({ side_effects: ["read_only"] })
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    180_000,
  )

  test(
    "invalid plugin arguments are rejected by the wrapper before execution",
    async () => {
      const ws = await workspace("plugin-invalid")
      const provider = mockProvider([
        { kind: "tool", call: { name: "plugin_echo", arguments: { wrong: "shape" } } },
        { kind: "text", content: "INVALID-ACK" },
      ])
      try {
        const slug = await createOperation(ws)
        const result = await run(ws, ["run", "call the plugin badly", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(pluginConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("INVALID-ACK")
        const events = ledger(ws, slug)
        expect(events.some((event) => event.kind === "tool.called" && event.source === "plugin_echo")).toBe(true)
        expect(events.some((event) => event.kind === "tool.error" && event.source === "plugin_echo")).toBe(true)
        expect(events.some((event) => event.kind === "tool.completed" && event.source === "plugin_echo")).toBe(false)
        expect(JSON.stringify(provider.transcripts()[1])).toContain("invalid arguments")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    180_000,
  )

  test(
    "pure mode does not load external plugin tools",
    async () => {
      const ws = await workspace("plugin-pure")
      const provider = mockProvider([{ kind: "text", content: "PURE-OK" }])
      try {
        await createOperation(ws)
        const result = await run(ws, ["run", "list tools", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(pluginConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
          AXIOMSEC_PURE: "1",
        })
        expect(result.code).toBe(0)
        expect(textOf(parseEvents(result.stdout))).toContain("PURE-OK")
        expect(requestToolNames(provider.requests()[0])).not.toContain("plugin_echo")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )
})
