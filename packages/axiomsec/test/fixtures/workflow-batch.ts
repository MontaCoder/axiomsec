import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const base = await fs.mkdtemp(path.join(os.tmpdir(), "axiomsec-batch-"))
process.env.XDG_CONFIG_HOME = path.join(base, "config")
process.env.XDG_DATA_HOME = path.join(base, "data")
process.env.XDG_CACHE_HOME = path.join(base, "cache")
process.env.XDG_STATE_HOME = path.join(base, "state")
process.env.AXIOMSEC_DB = path.join(base, "axiomsec.db")
process.env.AXIOMSEC_DISABLE_MODELS_FETCH = "1"
process.env.AXIOMSEC_DISABLE_AUTOUPDATE = "1"
process.env.AXIOMSEC_DISABLE_TELEMETRY = "1"

const workspace = path.join(base, "workspace")
await fs.mkdir(workspace, { recursive: true })

const { Operation } = await import("../../src/core/operation")
const { Cyber } = await import("../../src/core/cyber")
const { Instance } = await import("../../src/project/instance")
const { Effect } = await import("effect")

const created = await Operation.create({ workspace, label: "batch bench", kind: "pentest" })
const slug = created.slug
const trace = Array.from({ length: 10 }, (_, index) => ({
  kind: "tool",
  tool: index % 2 === 0 ? "workspace" : "evidence",
  label: `step ${index + 1}`,
  outcome: index < 5 ? "completed" : undefined,
}))
const input = {
  operation_slug: slug,
  workflow_kind: "play" as const,
  workflow_id: "batch",
  trace,
  skipped: [],
  completed_steps: 5,
  failed_steps: 0,
  pending_steps: 5,
  session_id: "session",
  message_id: "message",
  source: "workflow",
  summary: "batch workflow sync",
}

await Instance.provide({
  directory: workspace,
  fn: async () => {
    await Effect.runPromise(Cyber.syncWorkflowProgress(input))
    await Effect.runPromise(Cyber.syncWorkflowProgress({ ...input, completed_steps: 6, pending_steps: 4 }))
    let rolledBack = false
    try {
      await Effect.runPromise(
        Cyber.upsertFactsBatch({
          operation_slug: slug,
          facts: [
            {
              operation_slug: slug,
              entity_kind: "workflow_step",
              entity_key: "invalid",
              fact_name: "planned_step",
              value_json: { index: 99 },
              writer_kind: "tool",
              status: "observed",
              confidence: 1000,
            },
            {
              operation_slug: slug,
              entity_kind: null as unknown as string,
              entity_key: "invalid",
              fact_name: "planned_step",
              value_json: { index: 100 },
              writer_kind: "tool",
              status: "observed",
              confidence: 1000,
            },
          ],
        }),
      )
    } catch {
      rolledBack = true
    }
    const afterFailure = await Effect.runPromise(Cyber.listFacts({ operation_slug: slug, limit: 200 }))
    if (afterFailure.some((fact) => fact.entity_key === "invalid")) rolledBack = false

    const facts = await Effect.runPromise(Cyber.listFacts({ operation_slug: slug, limit: 200 }))
    const workflowFacts = facts.filter((fact) => fact.entity_kind === "workflow_step" || fact.entity_kind === "play")
    const projection = await fs.readFile(
      path.join(workspace, ".axiomsec", "operation", slug, "cyber", "facts.jsonl"),
      "utf8",
    )
    const records = projection
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line))
      .filter((record): record is Record<string, unknown> => {
        if (typeof record !== "object" || record === null) return false
        const kind: unknown = Reflect.get(record, "entity_kind")
        return kind === "workflow_step" || kind === "play"
      })
    const ids = new Set(workflowFacts.map((fact) => fact.id))
    const missingIds = records.filter((record) => !ids.has(String(record["id"])))

    console.log(
      JSON.stringify({
        ok: rolledBack && missingIds.length === 0,
        rolledBack,
        workflowFacts: workflowFacts.length,
        uniqueKeys: new Set(workflowFacts.map((fact) => fact.entity_key + ":" + fact.fact_name)).size,
        projectionRecords: records.length,
        missingIds: missingIds.length,
      }),
    )
  },
})
await fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
