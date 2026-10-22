import { describe, expect, test } from "bun:test"
import {
  bucketFindings,
  isReportableFinding,
  isSuspectedFinding,
  normalizeReplayExemption,
} from "@/core/cyber/finding"

const base = { kind: "finding" as const, status: "verified" as const, evidence_refs: ["aa"] }

describe("reportability predicate (SEC-05)", () => {
  test("requires a finding kind", () => {
    expect(isReportableFinding({ ...base, kind: "candidate" })).toBe(false)
  })

  test("requires the verified status", () => {
    expect(isReportableFinding({ ...base, status: "observed" })).toBe(false)
    expect(isReportableFinding({ ...base, status: "rejected" })).toBe(false)
  })

  test("requires at least one evidence ref", () => {
    expect(isReportableFinding({ ...base, evidence_refs: [] })).toBe(false)
  })

  test("replay present is sufficient on top of evidence", () => {
    expect(isReportableFinding({ ...base, replay_present: true })).toBe(true)
  })

  test("a legacy free-form reason is not a structured exemption", () => {
    expect(isReportableFinding({ ...base, replay_reason: "depends on an external service" })).toBe(false)
  })

  test("a structured exemption is accepted", () => {
    expect(
      isReportableFinding({
        ...base,
        replay_exemption: { category: "external_dependency", rationale: "target is a third-party service" },
      }),
    ).toBe(true)
  })

  test("replay absent and no exemption is not reportable", () => {
    expect(isReportableFinding(base)).toBe(false)
    expect(isSuspectedFinding(base)).toBe(true)
  })
})

describe("replay exemption normalization", () => {
  test("a legacy reason degrades to legacy_unspecified", () => {
    const normalized = normalizeReplayExemption({ replay_reason: "because" })
    expect(normalized?.category).toBe("legacy_unspecified")
  })

  test("a structured exemption keeps its category", () => {
    const normalized = normalizeReplayExemption({
      replay_exemption: { category: "destructive_target", rationale: "it deletes data" },
    })
    expect(normalized?.category).toBe("destructive_target")
    expect(normalized?.rationale).toBe("it deletes data")
  })

  test("an unknown category degrades to legacy_unspecified", () => {
    const normalized = normalizeReplayExemption({
      replay_exemption: { category: "made_up", rationale: "x" },
    })
    expect(normalized?.category).toBe("legacy_unspecified")
  })

  test("an exemption without a rationale is dropped", () => {
    expect(normalizeReplayExemption({ replay_exemption: { category: "external_dependency" } })).toBeUndefined()
  })
})

describe("finding buckets keep rejected claims visible", () => {
  const records = [
    { ...base, key: "promoted", replay_present: true },
    { ...base, key: "suspected" },
    { ...base, key: "rejected", status: "rejected" as const },
    { ...base, key: "stale", status: "stale" as const },
    { kind: "candidate" as const, status: "observed" as const, evidence_refs: [], key: "candidate" },
  ]

  const buckets = bucketFindings(records)

  test("every record stays visible in the total", () => {
    expect(buckets.all.length).toBe(5)
    expect(buckets.candidates.length).toBe(1)
  })

  test("rejected and stale stay visible", () => {
    expect(buckets.rejected.map((item) => item.key)).toEqual(["rejected", "stale"])
  })

  test("reportable and suspected are separated", () => {
    expect(buckets.reportable.map((item) => item.key)).toEqual(["promoted"])
    expect(buckets.suspected.map((item) => item.key)).toEqual(["suspected"])
  })

  test("candidates are not counted as suspected findings", () => {
    expect(buckets.suspected.map((item) => item.key)).not.toContain("candidate")
    expect(buckets.candidates.map((item) => item.key)).toContain("candidate")
  })

  test("a candidate superseded by a promoted finding is not double counted", () => {
    const withPair = bucketFindings([
      { kind: "candidate" as const, status: "observed" as const, evidence_refs: [], key: "same" },
      { ...base, key: "same", replay_present: true },
    ])
    expect(withPair.all.length).toBe(1)
    expect(withPair.candidates.length).toBe(0)
    expect(withPair.reportable.length).toBe(1)
  })
})
