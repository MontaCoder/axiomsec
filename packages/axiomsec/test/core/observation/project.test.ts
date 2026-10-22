import { describe, expect, test } from "bun:test"
import { project, severityCounts } from "@/core/observation/info"
import type { Event } from "@/core/observation/events"

const added = (id: string, at: number, extra: Partial<Extract<Event, { type: "observation_added" }>> = {}): Event => ({
  type: "observation_added",
  id,
  at,
  subtype: "vuln",
  title: `title ${id}`,
  ...extra,
})

describe("observation event projection", () => {
  test("preserves add order and defaults", () => {
    const result = project([added("a", 1), added("b", 2, { tags: ["x"], severity: "high", confidence: 0.5 })])
    expect(result.map((item) => item.id)).toEqual(["a", "b"])
    expect(result[0]).toMatchObject({ status: "open", tags: [], evidence: [] })
    expect(result[1]).toMatchObject({ tags: ["x"], severity: "high", confidence: 0.5 })
  })

  test("a duplicate add event is ignored", () => {
    const result = project([added("a", 1), added("a", 2, { title: "second" })])
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBe("title a")
  })

  test("updates apply only to existing observations", () => {
    const result = project([
      added("a", 1),
      { type: "observation_updated", id: "missing", at: 2, title: "ignored" },
      { type: "observation_updated", id: "a", at: 3, title: "new", status: "confirmed", tags: ["t"] },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ title: "new", status: "confirmed", tags: ["t"], updated_at: 3 })
  })

  test("a removed observation disappears even after later updates", () => {
    const result = project([
      added("a", 1),
      added("b", 2),
      { type: "observation_removed", id: "a", at: 3 },
      { type: "observation_updated", id: "a", at: 4, title: "zombie" },
      added("c", 5),
    ])
    expect(result.map((item) => item.id)).toEqual(["b", "c"])
  })

  test("evidence links are deduplicated and update the timestamp", () => {
    const result = project([
      added("a", 1),
      { type: "observation_evidence_linked", id: "a", evidence: "e1", at: 2 },
      { type: "observation_evidence_linked", id: "a", evidence: "e1", at: 3 },
      { type: "observation_evidence_linked", id: "a", evidence: "e2", at: 4 },
      { type: "observation_evidence_linked", id: "missing", evidence: "e3", at: 5 },
    ])
    expect(result[0]?.evidence).toEqual(["e1", "e2"])
    expect(result[0]?.updated_at).toBe(4)
  })

  test("severity counts classify unrated observations separately", () => {
    const result = project([
      added("a", 1, { severity: "critical" }),
      added("b", 2, { severity: "low" }),
      added("c", 3),
      added("d", 4, { severity: "critical" }),
    ])
    expect(severityCounts(result)).toEqual({ info: 0, low: 1, medium: 0, high: 0, critical: 2, none: 1 })
  })

  test("an empty event stream yields an empty projection", () => {
    expect(project([])).toEqual([])
  })
})
