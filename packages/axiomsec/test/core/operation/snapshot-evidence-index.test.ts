import { describe, expect, test } from "bun:test"
import type { Fact, Relation } from "@/core/cyber"
import type { EvidenceEntry } from "@/core/evidence"
import { evidenceIndex, type SnapshotRoute } from "@/core/operation/snapshot"

function fact(input: Partial<Fact> & Pick<Fact, "entity_kind" | "entity_key">): Fact {
  return {
    id: `cfact_${input.entity_key}`,
    project_id: "project",
    operation_slug: "op",
    fact_name: "record",
    value_json: {},
    writer_kind: "tool",
    status: "observed",
    time_created: 0,
    time_updated: 0,
    ...input,
  }
}

function relation(input: Partial<Relation> & Pick<Relation, "src_kind" | "src_key" | "dst_kind" | "dst_key">): Relation {
  return {
    id: `crel_${input.src_key}_${input.dst_key}`,
    project_id: "project",
    operation_slug: "op",
    relation: "observed_at",
    writer_kind: "tool",
    status: "observed",
    time_created: 0,
    time_updated: 0,
    ...input,
  }
}

function route(key: string): SnapshotRoute {
  return {
    key,
    fact_names: [],
    status: "observed",
    evidence_refs: [],
    source_event_ids: [],
    time_updated: 0,
  }
}

function entry(sha256: string, at: number): EvidenceEntry {
  return { sha256, ext: "txt", size: 1, at }
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function legacy(input: {
  entries: EvidenceEntry[]
  facts: Fact[]
  relations: Relation[]
  routes: SnapshotRoute[]
}) {
  const routeKeys = new Set(input.routes.map((item) => item.key))
  const normalize = (ref: string) => (ref.startsWith("sha256:") ? ref.slice("sha256:".length) : ref)
  const asObject = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  return input.entries
    .map((item) => {
      const sha = normalize(item.sha256)
      const linkedFindingKeys = input.facts
        .filter((f) => (f.evidence_refs ?? []).map(normalize).includes(sha))
        .filter((f) => f.entity_kind === "finding" || f.entity_kind === "finding_candidate")
        .map((f) => f.entity_key)
      const linkedObservationIds = input.facts
        .filter((f) => f.entity_kind === "observation" && f.fact_name === "record")
        .filter((f) => {
          const value = asObject(f.value_json)
          const valueEvidence = Array.isArray(value?.evidence) ? value.evidence.map((v) => normalize(String(v))) : []
          return valueEvidence.includes(sha) || (f.evidence_refs ?? []).map(normalize).includes(sha)
        })
        .map((f) => f.entity_key)
      const relationFindingKeys = input.relations
        .filter((r) => normalize(r.dst_key) === sha || normalize(r.src_key) === sha)
        .filter((r) => r.src_kind === "finding" || r.dst_kind === "finding")
        .map((r) => (r.src_kind === "finding" ? r.src_key : r.dst_key))
      const relationObservationIds = input.relations
        .filter((r) => normalize(r.dst_key) === sha || normalize(r.src_key) === sha)
        .filter((r) => r.src_kind === "observation" || r.dst_kind === "observation")
        .map((r) => (r.src_kind === "observation" ? r.src_key : r.dst_key))
      const linkedRoutes = input.facts
        .filter((f) => f.entity_kind === "http_route")
        .filter((f) => (f.evidence_refs ?? []).map(normalize).includes(sha))
        .map((f) => f.entity_key)
      const relationRoutes = input.relations
        .filter((r) => (r.evidence_refs ?? []).map(normalize).includes(sha))
        .flatMap((r) => [r.src_key, r.dst_key].filter((key) => routeKeys.has(key)))
      const replayLabels = input.facts
        .filter((f) => f.entity_kind === "finding" && f.fact_name === "replay_bundle")
        .filter((f) => (f.evidence_refs ?? []).map(normalize).includes(sha))
        .map((f) => f.entity_key)
      return {
        ...item,
        linked_finding_keys: unique([...linkedFindingKeys, ...relationFindingKeys]),
        linked_observation_ids: unique([...linkedObservationIds, ...relationObservationIds]),
        linked_routes: unique([...linkedRoutes, ...relationRoutes]),
        replay_labels: unique(replayLabels),
      }
    })
    .sort((a, b) => b.at - a.at)
}

describe("evidence index parity", () => {
  test("keeps the same links, order and dedupe as the per-entry scan", () => {
    const facts = [
      fact({ entity_kind: "finding", entity_key: "F1", evidence_refs: ["aa", "sha256:bb"] }),
      fact({ entity_kind: "finding_candidate", entity_key: "C1", evidence_refs: ["bb"] }),
      fact({
        entity_kind: "observation",
        entity_key: "O1",
        value_json: { evidence: ["aa", "sha256:bb"] },
        evidence_refs: ["cc"],
      }),
      fact({ entity_kind: "http_route", entity_key: "R1", evidence_refs: ["bb"] }),
      fact({ entity_kind: "finding", entity_key: "F1", fact_name: "replay_bundle", evidence_refs: ["cc"] }),
      fact({ entity_kind: "host", entity_key: "H1", evidence_refs: ["aa"] }),
      fact({ entity_kind: "unknown", entity_key: "X1", evidence_refs: ["cc"] }),
    ]
    const relations = [
      relation({
        src_kind: "finding",
        src_key: "F2",
        dst_kind: "http_route",
        dst_key: "R1",
        evidence_refs: ["aa", "aa"],
      }),
      relation({
        src_kind: "observation",
        src_key: "O2",
        dst_kind: "finding",
        dst_key: "F3",
        evidence_refs: ["bb"],
      }),
      relation({
        src_kind: "http_route",
        src_key: "R1",
        dst_kind: "http_route",
        dst_key: "R2",
        evidence_refs: ["cc"],
      }),
    ]
    const entries = [entry("sha256:aa", 1), entry("bb", 3), entry("cc", 2)]
    const routes = [route("R1"), route("R2")]
    const input = { entries, facts, relations, routes }
    expect(evidenceIndex(input)).toEqual(legacy(input))
  })

  test("empty inputs stay empty", () => {
    expect(evidenceIndex({ entries: [], facts: [], relations: [], routes: [] })).toEqual([])
  })
})
