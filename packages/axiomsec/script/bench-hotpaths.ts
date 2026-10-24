#!/usr/bin/env bun

/**
 * Hot-path benchmark for the operation/snapshot/cyber read path.
 *
 *   bun run --cwd packages/axiomsec script/bench-hotpaths.ts
 *
 * Every number is local-machine relative. The fixture is synthetic and
 * disposable: it never reads the developer's real workspace or state.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const base = await fs.mkdtemp(path.join(os.tmpdir(), "axiomsec-hotpaths-"))
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

const { Operation } = await import("../src/core/operation")
const Snapshot = await import("../src/core/operation/snapshot")
const Evidence = await import("../src/core/evidence/store")
const { Cyber } = await import("../src/core/cyber")
const { Instance } = await import("../src/project/instance")
const { Effect } = await import("effect")

const FACT_COUNT = 2_000
const RELATION_COUNT = 2_000
const EVIDENCE_COUNT = 500
const SNAPSHOT_RUNS = 15
const READ_RUNS = 30
const WORKFLOW_STEPS = 10
const WORKFLOW_RUNS = 10

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    samples: values.length,
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

async function timed(runs: number, fn: () => Promise<unknown>) {
  await fn()
  await fn()
  const samples: number[] = []
  for (let index = 0; index < runs; index++) {
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  return stats(samples)
}

function fact(index: number, slug: string, projectID: string) {
  const evidence = `sha256:${(index % EVIDENCE_COUNT).toString(16).padStart(64, "0")}`
  return {
    id: `cfact_${index}`,
    project_id: projectID,
    operation_slug: slug,
    entity_kind: index % 5 === 0 ? "finding" : index % 3 === 0 ? "http_route" : "host",
    entity_key: `entity-${index}`,
    fact_name: index % 5 === 0 ? "record" : "observed",
    value_json: { title: `entity ${index}`, status: "observed", severity: "low" },
    writer_kind: "tool",
    status: "observed",
    confidence: 1000,
    source_event_id: null,
    evidence_refs: [evidence],
    expires_at: null,
    time_created: index,
    time_updated: index,
  }
}

function relation(index: number, slug: string, projectID: string) {
  return {
    id: `crel_${index}`,
    project_id: projectID,
    operation_slug: slug,
    src_kind: "finding",
    src_key: `entity-${index}`,
    relation: "observed_at",
    dst_kind: "http_route",
    dst_key: `entity-${index + 1}`,
    writer_kind: "tool",
    status: "observed",
    confidence: 1000,
    source_event_id: null,
    evidence_refs: [`sha256:${(index % EVIDENCE_COUNT).toString(16).padStart(64, "0")}`],
    time_created: index,
    time_updated: index,
  }
}

function evidence(index: number) {
  return {
    sha256: (index % EVIDENCE_COUNT).toString(16).padStart(64, "0"),
    ext: "txt",
    size: 128,
    mime: "text/plain",
    label: `artifact ${index}`,
    source: "bench",
    at: index,
  }
}

async function main() {
  const created = await Operation.create({ workspace, label: "hotpath bench", kind: "pentest", target: "127.0.0.1" })
  const slug = created.slug
  const projectID = await Instance.provide({ directory: workspace, fn: () => Instance.project.id })
  const opRoot = path.join(workspace, ".axiomsec", "operation", slug)
  const cyberDir = path.join(opRoot, "cyber")
  await fs.mkdir(cyberDir, { recursive: true })
  const facts = Array.from({ length: FACT_COUNT }, (_, index) => fact(index, slug, projectID))
  const relations = Array.from({ length: RELATION_COUNT }, (_, index) => relation(index, slug, projectID))
  await fs.writeFile(path.join(cyberDir, "facts.jsonl"), facts.map((item) => JSON.stringify(item)).join("\n") + "\n")
  await fs.writeFile(
    path.join(cyberDir, "relations.jsonl"),
    relations.map((item) => JSON.stringify(item)).join("\n") + "\n",
  )
  await fs.writeFile(
    path.join(cyberDir, "ledger.jsonl"),
    facts
      .slice(0, 1_000)
      .map((item) =>
        JSON.stringify({
          id: `cled_${item.id}`,
          project_id: projectID,
          operation_slug: slug,
          kind: "tool.completed",
          source: "bench",
          status: "completed",
          summary: "synthetic ledger event",
          data: { tool: "bench" },
          time_created: item.time_created,
        }),
      )
      .join("\n") + "\n",
  )
  const evidenceDir = path.join(opRoot, "evidence")
  await fs.mkdir(evidenceDir, { recursive: true })
  await fs.writeFile(
    path.join(evidenceDir, "manifest.jsonl"),
    Array.from({ length: EVIDENCE_COUNT }, (_, index) => JSON.stringify(evidence(index))).join("\n") + "\n",
  )
  const initialContext = path.join(opRoot, "context", "active-context.md")
  await fs.writeFile(initialContext, "# Active Operation Context\ngenerated_at: synthetic\n")

  const result: Record<string, unknown> = {
    fixture: { facts: FACT_COUNT, relations: RELATION_COUNT, evidence: EVIDENCE_COUNT, workflow_steps: WORKFLOW_STEPS },
    operationRead: await timed(READ_RUNS, () => Operation.read(workspace, slug)),
    evidenceList: await timed(READ_RUNS, () => Evidence.list(workspace, slug)),
    snapshotBuild: await timed(SNAPSHOT_RUNS, () =>
      Snapshot.build(workspace, { slug, includeDoctor: false, maxEvidence: 200 }),
    ),
    workflowSync: await timed(WORKFLOW_RUNS, () =>
      Instance.provide({
        directory: workspace,
        fn: () =>
          Effect.runPromise(
            Cyber.syncWorkflowProgress({
              operation_slug: slug,
              workflow_kind: "play",
              workflow_id: "hotpath",
              trace: Array.from({ length: WORKFLOW_STEPS }, (_, index) => ({
                kind: "tool",
                tool: index % 2 === 0 ? "workspace" : "evidence",
                label: `step ${index + 1}`,
                outcome: index < WORKFLOW_STEPS / 2 ? "completed" : undefined,
              })),
              skipped: [],
              completed_steps: WORKFLOW_STEPS / 2,
              failed_steps: 0,
              pending_steps: WORKFLOW_STEPS / 2,
              session_id: "bench",
              message_id: "bench",
              source: "workflow",
              summary: "hotpath workflow sync",
            }),
          ),
      }),
    ),
  }

  const large = path.join(base, "large-evidence.bin")
  const handle = await fs.open(large, "w")
  await handle.truncate(64 * 1024 * 1024)
  await handle.close()
  const rssBefore = process.memoryUsage().rss
  const putStart = performance.now()
  const largeEntry = await Evidence.put(workspace, slug, { path: large })
  const putMs = performance.now() - putStart
  const rssAfterPut = process.memoryUsage().rss
  const previewStart = performance.now()
  const preview = await Evidence.get(workspace, slug, largeEntry.sha256, { maxBytes: 4000 })
  const previewMs = performance.now() - previewStart
  const rssAfterPreview = process.memoryUsage().rss
  const verifyStart = performance.now()
  const verified = await Evidence.verify(workspace, slug, largeEntry.sha256)
  const verifyMs = performance.now() - verifyStart
  const rssAfterVerify = process.memoryUsage().rss
  const fullStart = performance.now()
  const full = await Evidence.get(workspace, slug, largeEntry.sha256)
  const fullGetMs = performance.now() - fullStart
  const rssAfterFull = process.memoryUsage().rss
  result.largeEvidence = {
    sizeMb: 64,
    putMs: round(putMs),
    previewMs: round(previewMs),
    verifyMs: round(verifyMs),
    fullGetMs: round(fullGetMs),
    rssPutDeltaMb: round((rssAfterPut - rssBefore) / 1024 / 1024),
    rssPreviewDeltaMb: round((rssAfterPreview - rssAfterPut) / 1024 / 1024),
    rssVerifyDeltaMb: round((rssAfterVerify - rssAfterPreview) / 1024 / 1024),
    rssFullDeltaMb: round((rssAfterFull - rssAfterVerify) / 1024 / 1024),
    verified,
    previewBytes: preview?.bytes.length,
    fullBytes: full?.bytes.length,
  }
  console.log(JSON.stringify(result, null, 2))
}

try {
  await main()
} finally {
  await fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
}
