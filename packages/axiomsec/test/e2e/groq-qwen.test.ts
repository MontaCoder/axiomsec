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
 * Live Groq test. Opt-in because it performs a real paid request:
 *
 *   GROQ_API_KEY=... GROQ_LIVE=1 bun test test/e2e/groq-qwen.test.ts
 *
 * The key is only read from the environment and never persisted. The model
 * and prompts are pinned so a failure points at the provider path or the
 * agent loop, not at a different model's prose.
 */
const BIN = binaryPath()
const KEY = process.env.GROQ_API_KEY
const LIVE = process.env.GROQ_LIVE === "1" && Boolean(KEY)

const MODEL = "qwen/qwen3.8-27b"

// Groq's on-demand tier allows 7,000 input tokens per minute for this model.
// A hidden agent skips the large provider baseline, and the exclusion list
// leaves only the two tools the live task is allowed to call.
const EXCLUDED = [
  "analyze",
  "apply_patch",
  "appsec_probe",
  "autonomy",
  "bash",
  "binary_triage",
  "browser",
  "cloud_posture",
  "codesearch",
  "container_surface",
  "crypto",
  "cve",
  "doctor",
  "edit",
  "finding",
  "glob",
  "grep",
  "iac_triage",
  "identity",
  "interact",
  "invalid",
  "knowledge",
  "methodology",
  "net",
  "observation",
  "opsec",
  "plan_exit",
  "play",
  "pwn_bootstrap",
  "question",
  "read",
  "remediate",
  "report",
  "runbook",
  "scanner",
  "scope",
  "share",
  "skill",
  "task",
  "todowrite",
  "vault",
  "webfetch",
  "websearch",
  "workspace",
  "write",
]

function liveConfig() {
  return {
    model: `groq/${MODEL}`,
    provider: {
      groq: {
        name: "Groq",
        env: ["GROQ_API_KEY"],
        models: {
          [MODEL]: {
            name: "Qwen3.8 27B",
            tool_call: true,
            limit: { context: 131_072, output: 16_384 },
            cost: { input: 0.8, output: 4 },
          },
        },
      },
    },
    agent: {
      qwen: {
        description: "Minimal Groq Qwen acceptance agent",
        mode: "primary",
        hidden: true,
        prompt: "You are a concise AxiomSec test agent. Follow the user's instruction exactly.",
        toolset_exclude: EXCLUDED,
      },
    },
  }
}

async function createOperation(ws: Awaited<ReturnType<typeof workspace>>, target: string) {
  const result = await run(ws, ["operation", "new", "Live Groq", "--kind", "pentest", "--target", target])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1]
}

describe.skipIf(!LIVE || !BIN)("live Groq provider (Qwen3.8 27B)", () => {
  test(
    "the real model answers through the provider",
    async () => {
      const ws = await workspace("groq-text")
      try {
        const result = await run(
          ws,
          ["run", "Reply with exactly GROQ-QWEN-OK and nothing else.", "--format", "json", "--agent", "qwen"],
          {
            AXIOMSEC_CONFIG_CONTENT: JSON.stringify(liveConfig()),
            GROQ_API_KEY: KEY!,
            AXIOMSEC_DISABLE_MODELS_FETCH: "1",
          },
        )
        const events = parseEvents(result.stdout)
        const failure = providerFailure(events)
        if (failure) throw new Error(`Groq live call failed: ${failure}`)
        expect(result.code).toBe(0)
        expect(textOf(events)).toContain("GROQ-QWEN-OK")
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
      const ws = await workspace("groq-tools")
      let hits = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          hits += 1
          return Response.json({ status: "ok", marker: "GROQ-LOCAL-FIXTURE-VALUE" })
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
              `store the response body and label it "groq-live-proof". Finally reply with GROQ-TOOL-CHAIN-OK.`,
            "--format",
            "json",
            "--agent",
            "qwen",
            "--dangerously-skip-permissions",
          ],
          {
            AXIOMSEC_CONFIG_CONTENT: JSON.stringify(liveConfig()),
            GROQ_API_KEY: KEY!,
            AXIOMSEC_DISABLE_MODELS_FETCH: "1",
          },
        )
        const events = parseEvents(result.stdout)
        const failure = providerFailure(events)
        if (failure) throw new Error(`Groq live call failed: ${failure}`)
        expect(result.code).toBe(0)
        expect(textOf(events)).toContain("GROQ-TOOL-CHAIN-OK")
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
