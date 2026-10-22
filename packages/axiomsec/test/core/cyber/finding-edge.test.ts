import { describe, expect, test } from "bun:test"
import {
  bucketFindings,
  candidateSummary,
  candidateTitle,
  isRejectedFinding,
  isReportableFinding,
  isReplayBackedFinding,
  isReplayExemptFinding,
  isSuspectedFinding,
  normalizeFindingRecords,
  normalizeReplayExemption,
  replayState,
  summarizeFindingFact,
  type FindingRecord,
  type FindingShape,
} from "@/core/cyber/finding"

const verified = {
  kind: "finding" as const,
  status: "verified" as const,
  evidence_refs: ["a".repeat(64)],
}

describe("reportability is a strict conjunction", () => {
  test("requires all four conditions", () => {
    expect(isReportableFinding({ ...verified, replay_present: true })).toBe(true)
    expect(isReportableFinding({ ...verified, kind: "candidate", replay_present: true })).toBe(false)
    expect(isReportableFinding({ ...verified, status: "observed", replay_present: true })).toBe(false)
    expect(isReportableFinding({ ...verified, evidence_refs: [], replay_present: true })).toBe(false)
    expect(isReportableFinding({ ...verified })).toBe(false)
  })

  test("a malformed evidence_refs field is not accepted", () => {
    expect(isReportableFinding({ ...verified, evidence_refs: "sha" as unknown as string[] })).toBe(false)
    expect(isReportableFinding({ ...verified, evidence_refs: null as unknown as string[] })).toBe(false)
  })

  test("replay_present must be truthy, not merely defined", () => {
    expect(isReportableFinding({ ...verified, replay_present: false })).toBe(false)
  })

  test("a structured exemption requires a category and a non-empty rationale", () => {
    expect(
      isReportableFinding({
        ...verified,
        replay_exemption: { category: "external_dependency", rationale: "  " },
      }),
    ).toBe(false)
    expect(
      isReportableFinding({
        ...verified,
        replay_exemption: { category: "external_dependency", rationale: "upstream service" },
      }),
    ).toBe(true)
  })

  test("an unknown category degrades to legacy and does not satisfy the gate", () => {
    expect(
      isReportableFinding({
        ...verified,
        replay_exemption: { category: "made_up", rationale: "because" } as unknown as FindingShape["replay_exemption"],
      }),
    ).toBe(false)
  })

  test("a legacy free-form reason is never enough", () => {
    expect(isReportableFinding({ ...verified, replay_reason: "upstream service" })).toBe(false)
  })

  test("replay state distinguishes present, exempt and missing", () => {
    expect(replayState({ kind: "finding", replay_present: true })).toBe("present")
    expect(replayState({ kind: "finding", replay_reason: "because" })).toBe("exempt")
    expect(
      replayState({
        kind: "finding",
        replay_exemption: { category: "external_dependency", rationale: "upstream" },
      } as never),
    ).toBe("exempt")
    expect(replayState({ kind: "finding" })).toBe("missing")
    expect(replayState({ kind: "candidate" })).toBeUndefined()
    expect(isReplayBackedFinding({ kind: "finding", replay_present: true })).toBe(true)
    expect(isReplayExemptFinding({ kind: "finding", replay_reason: "because" })).toBe(true)
  })

  test("rejected and stale are the only rejected states", () => {
    expect(isRejectedFinding({ kind: "finding", status: "rejected" })).toBe(true)
    expect(isRejectedFinding({ kind: "finding", status: "stale" })).toBe(true)
    expect(isRejectedFinding({ kind: "finding", status: "verified" })).toBe(false)
    expect(isRejectedFinding({ kind: "finding", status: "observed" })).toBe(false)
  })

  test("only promoted findings can be suspected", () => {
    expect(isSuspectedFinding({ kind: "candidate", status: "observed" })).toBe(false)
    expect(isSuspectedFinding({ kind: "finding", status: "observed" })).toBe(true)
    expect(isSuspectedFinding({ kind: "finding", status: "verified", replay_present: true, evidence_refs: ["x"] })).toBe(false)
    expect(isSuspectedFinding({ kind: "finding", status: "rejected" })).toBe(false)
  })

  test("an empty-string evidence ref does not count", () => {
    expect(isReportableFinding({ ...verified, evidence_refs: [""], replay_present: true })).toBe(false)
  })
})

describe("normalization", () => {
  const candidate = { kind: "candidate" as const, status: "observed" as const, key: "same" }
  const finding = (status: string) => ({ ...verified, status, key: "same" })

  test("a verified finding supersedes its candidate", () => {
    expect(normalizeFindingRecords([candidate, finding("verified")])).toEqual([finding("verified")])
  })

  test("rejected and stale findings supersede their candidates", () => {
    expect(normalizeFindingRecords([candidate, finding("rejected")])).toHaveLength(1)
    expect(normalizeFindingRecords([candidate, finding("stale")])).toHaveLength(1)
  })

  test("an observed finding does not supersede a candidate", () => {
    expect(normalizeFindingRecords([candidate, finding("observed")])).toHaveLength(2)
  })

  test("candidates with other keys remain visible", () => {
    expect(normalizeFindingRecords([candidate, { ...candidate, key: "other" }, finding("verified")])).toHaveLength(2)
  })

  test("replay exemptions normalize optional fields", () => {
    expect(
      normalizeReplayExemption({
        replay_exemption: {
          category: "time_bound_access",
          rationale: "window closed",
          domain: "pentest",
          approved_by_kind: "operator",
        },
      }),
    ).toEqual({
      category: "time_bound_access",
      rationale: "window closed",
      domain: "pentest",
      approved_by_kind: "operator",
    })
    expect(normalizeReplayExemption({ replay_reason: "   " })).toBeUndefined()
    expect(normalizeReplayExemption({ replay_exemption: [] })).toBeUndefined()
  })
})

describe("buckets are exhaustive and non-overlapping", () => {
  const records: FindingRecord[] = [
    { key: "c1", kind: "candidate", fact_name: "x", status: "observed" },
    { key: "r1", kind: "finding", fact_name: "record", status: "verified", evidence_refs: ["a"], replay_present: true },
    {
      key: "e1",
      kind: "finding",
      fact_name: "record",
      status: "verified",
      evidence_refs: ["b"],
      replay_exemption: { category: "external_dependency", rationale: "upstream" },
    },
    { key: "s1", kind: "finding", fact_name: "record", status: "verified", evidence_refs: ["c"] },
    { key: "x1", kind: "finding", fact_name: "record", status: "rejected", evidence_refs: ["d"] },
  ]

  const buckets = bucketFindings(records)

  test("every record appears exactly once across the main buckets", () => {
    const ids = [
      ...buckets.candidates,
      ...buckets.reportable,
      ...buckets.suspected,
      ...buckets.rejected,
    ].map((item) => (item).key)
    expect(ids.sort()).toEqual(["c1", "e1", "r1", "s1", "x1"])
  })

  test("structured exemptions are counted as replay-exempt and reportable", () => {
    expect(buckets.replay_exempt.map((item) => item.key)).toEqual(["e1"])
    expect(buckets.reportable.map((item) => item.key).sort()).toEqual(["e1", "r1"])
    expect(buckets.replay_backed.map((item) => item.key)).toEqual(["r1"])
  })

  test("candidates are never suspected", () => {
    expect(buckets.suspected.map((item) => item.key)).toEqual(["s1"])
  })
})

describe("finding fact projection", () => {
  test("a candidate record uses its title and summary fallbacks", () => {
    const fact = {
      entity_kind: "finding_candidate",
      entity_key: "c",
      fact_name: "x",
      status: "observed",
      value_json: { title: "T", description: "D", severity: "high" },
      evidence_refs: ["e"],
    } as never
    expect(summarizeFindingFact(fact)).toMatchObject({
      key: "c",
      kind: "candidate",
      title: "T",
      summary: "D",
      severity: "high",
      evidence_refs: ["e"],
    })
  })

  test("a candidate without a title falls back to check_name, check_id, fact_name", () => {
    expect(candidateTitle("fact", { check_name: "C" }, "k")).toBe("C")
    expect(candidateTitle("fact", { check_id: "ID" }, "k")).toBe("ID")
    expect(candidateTitle("fact", {}, "k")).toBe("fact")
    expect(candidateSummary({ message: "M" })).toBe("M")
    expect(candidateSummary({ title: "T" })).toBe("T")
    expect(candidateSummary(undefined)).toBeUndefined()
  })

  test("a finding record carries its structured exemption and proof fields", () => {
    const fact = {
      entity_kind: "finding",
      entity_key: "f",
      fact_name: "record",
      status: "verified",
      value_json: {
        title: "T",
        summary: "S",
        proof_summary: "P",
        severity: "critical",
        replay_present: false,
        replay_exemption: { category: "external_dependency", rationale: "upstream" },
        oracle_status: "passed",
        oracle_reason: "ok",
        operator_promoted: true,
      },
      evidence_refs: ["e"],
      source_event_id: "evt",
    } as never
    const record = summarizeFindingFact(fact)
    expect(record?.replay_exemption?.category).toBe("external_dependency")
    expect(record?.oracle_status).toBe("passed")
    expect(record?.operator_promoted).toBe(true)
    expect(isReportableFinding(record!)).toBe(true)
  })

  test("unrelated facts are ignored", () => {
    expect(
      summarizeFindingFact({ entity_kind: "host", entity_key: "h", fact_name: "x", status: "observed", value_json: {} } as never),
    ).toBeUndefined()
    expect(
      summarizeFindingFact({ entity_kind: "finding", entity_key: "f", fact_name: "other", status: "verified", value_json: {} } as never),
    ).toBeUndefined()
  })
})
