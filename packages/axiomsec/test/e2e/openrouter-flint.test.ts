import { describe, expect, test } from "bun:test"
import { binaryPath, ledger, run, workspace } from "../support/harness"
import { parseEvents, textOf } from "../support/provider"

function providerFailure(events: Array<Record<string, unknown>>): string | undefined {
  const error = events.find((event) => event.type === "error") as
    | { error?: { name?: string; data?: { message?: string } } }
    | undefined
  if (!error) return undefined
  return error.error?.data?.message ?? error.error?.name ?? "provider error"
}

/**
 * Live OpenRouter test. It is opt-in because it costs a real network request
 * and depends on the account's free-model quota:
 *
 *   OPENROUTER_API_KEY=... OPENROUTER_LIVE=1 bun test test/e2e/openrouter-flint.test.ts
 *
 * The suite never records the key. The model and prompt are pinned so a
 * failure means the provider path or the agent loop is broken, not that a
 * different model produced different prose.
 */
const BIN = binaryPath()
const KEY = process.env.OPENROUTER_API_KEY
const LIVE = process.env.OPENROUTER_LIVE === "1" && Boolean(KEY)

const MODEL = "recursive/flint-v1.0:free"

function liveConfig() {
  return {
    model: `openrouter/${MODEL}`,
    provider: {
      openrouter: {
        name: "OpenRouter",
        env: ["OPENROUTER_API_KEY"],
        models: {
          [MODEL]: {
            name: "Recursive: Flint",
            tool_call: true,
            limit: { context: 262_144, output: 8_192 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }
}

async function createOperation(ws: Awaited<ReturnType<typeof workspace>>, target: string) {
  const result = await run(ws, ["operation", "new", "Live Flint", "--kind", "pentest", "--target", target])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1]
}

describe.skipIf(!LIVE || !BIN)("live OpenRouter provider (Flint)", () => {
  test(
    "the real model answers through the provider",
    async () => {
      const ws = await workspace("openrouter-text")
      try {
        const result = await run(
          ws,
          ["run", "Reply with exactly OPENROUTER-FLINT-OK and nothing else.", "--format", "json"],
          {
            AXIOMSEC_CONFIG_CONTENT: JSON.stringify(liveConfig()),
            OPENROUTER_API_KEY: KEY!,
            AXIOMSEC_DISABLE_MODELS_FETCH: "1",
          },
        )
        const events = parseEvents(result.stdout)
        const failure = providerFailure(events)
        if (failure) throw new Error(`OpenRouter live call failed: ${failure}`)
        expect(result.code).toBe(0)
        expect(textOf(events)).toContain("OPENROUTER-FLINT-OK")
        expect(events.some((event) => event.type === "step_finish")).toBe(true)
      } finally {
        await ws.cleanup()
      }
    },
    180_000,
  )

  test(
    "the real model uses a guarded tool and the result reaches the operation kernel",
    async () => {
      const ws = await workspace("openrouter-tools")
      let hits = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          hits += 1
          return Response.json({ status: "ok", marker: "LOCAL-FIXTURE-VALUE" })
        },
      })
      try {
        const target = `http://127.0.0.1:${server.port}`
        const slug = await createOperation(ws, target)
        const result = await run(
          ws,
          [
            "run",
            `Use the http_request tool to GET ${target}/health. Then call evidence with action add_text, ` +
              `store the response body and label it "live-proof". Finally reply with LIVE-TOOL-CHAIN-OK.`,
            "--format",
            "json",
            "--dangerously-skip-permissions",
          ],
          {
            AXIOMSEC_CONFIG_CONTENT: JSON.stringify(liveConfig()),
            OPENROUTER_API_KEY: KEY!,
            AXIOMSEC_DISABLE_MODELS_FETCH: "1",
          },
        )
        const events = parseEvents(result.stdout)
        const failure = providerFailure(events)
        if (failure) throw new Error(`OpenRouter live call failed: ${failure}`)
        expect(result.code).toBe(0)
        expect(textOf(events)).toContain("LIVE-TOOL-CHAIN-OK")
        expect(hits).toBeGreaterThanOrEqual(1)

        const recorded = ledger(ws, slug!)
        expect(
          recorded.some((event) => event.kind === "tool.completed" && event.source === "http_request"),
        ).toBe(true)
        expect(recorded.some((event) => event.kind === "tool.completed" && event.source === "evidence")).toBe(true)
        expect(recorded.filter((event) => event.kind === "evidence.added").length).toBeGreaterThanOrEqual(1)
        expect(recorded.some((event) => event.kind === "tool.error")).toBe(false)
      } finally {
        server.stop(true)
        await ws.cleanup()
      }
    },
    240_000,
  )
})
