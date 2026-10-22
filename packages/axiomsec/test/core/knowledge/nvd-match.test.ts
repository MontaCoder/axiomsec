import { describe, expect, test } from "bun:test"
import { normalizeComponent } from "@/core/knowledge/component"
import { collectNvdRanges, evaluateNvdApplicability, type NvdVersionRange } from "@/core/knowledge/nvd-match"

const nginx = () => normalizeComponent("nginx 1.21.0")!
const range = (input: Partial<NvdVersionRange> = {}): NvdVersionRange => ({
  criteria: "cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*",
  vulnerable: true,
  ...input,
})

describe("NVD range collection", () => {
  test("walks nested children and both cpeMatch spellings", () => {
    const ranges = collectNvdRanges([
      {
        cpeMatch: [{ criteria: "cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*", vulnerable: true, versionEndExcluding: "1.21.1" }],
        children: [
          {
            cpe_match: [
              {
                cpe23Uri: "cpe:2.3:a:nginx:nginx:*:*:*:*:*:*:*:*",
                vulnerable: false,
                versionStartIncluding: "1.18.0",
              },
            ],
          },
        ],
      },
    ])
    expect(ranges).toHaveLength(2)
    expect(ranges[0]?.versionEndExcluding).toBe("1.21.1")
    expect(ranges[1]?.criteria).toContain("nginx:nginx")
    expect(ranges[1]?.vulnerable).toBe(false)
  })

  test("ignores malformed nodes and entries without criteria", () => {
    expect(collectNvdRanges(null)).toEqual([])
    expect(collectNvdRanges([{ cpeMatch: [{ vulnerable: true }] }, { children: 3 }, "x"])).toEqual([])
  })
})

describe("NVD applicability", () => {
  test("no component is always unknown", () => {
    const verdict = evaluateNvdApplicability({ ranges: [range({ versionEndExcluding: "2.0" })] })
    expect(verdict.state).toBe("unknown")
    expect(verdict.version_match).toBe("unknown")
  })

  test("no ranges is unknown, never not-applicable", () => {
    const verdict = evaluateNvdApplicability({ component: nginx(), ranges: [] })
    expect(verdict.state).toBe("unknown")
    expect(verdict.confidence).toBe("unknown")
  })

  test("a version inside an end-excluding range is applicable", () => {
    const verdict = evaluateNvdApplicability({
      component: nginx(),
      ranges: [range({ versionStartIncluding: "1.18.0", versionEndExcluding: "1.21.1" })],
    })
    expect(verdict.state).toBe("applicable")
    expect(verdict.version_match).toBe(true)
    expect(verdict.confidence).toBe("high")
    expect(verdict.affected_range).toContain("< 1.21.1")
  })

  test("the end-excluding boundary itself is not applicable", () => {
    const verdict = evaluateNvdApplicability({
      component: normalizeComponent("nginx 1.21.1")!,
      ranges: [range({ versionEndExcluding: "1.21.1" })],
    })
    expect(verdict.state).toBe("not_applicable")
    expect(verdict.version_match).toBe(false)
  })

  test("the end-including boundary is applicable", () => {
    const verdict = evaluateNvdApplicability({
      component: normalizeComponent("nginx 1.21.1")!,
      ranges: [range({ versionEndIncluding: "1.21.1" })],
    })
    expect(verdict.state).toBe("applicable")
  })

  test("start-excluding and start-including boundaries are honoured", () => {
    const component = normalizeComponent("nginx 1.20.0")!
    expect(evaluateNvdApplicability({ component, ranges: [range({ versionStartIncluding: "1.20.0" })] }).state).toBe(
      "applicable",
    )
    expect(evaluateNvdApplicability({ component, ranges: [range({ versionStartExcluding: "1.20.0" })] }).state).toBe(
      "not_applicable",
    )
  })

  test("numeric versions compare numerically, not lexically", () => {
    const component = normalizeComponent("nginx 1.9.0")!
    const verdict = evaluateNvdApplicability({ component, ranges: [range({ versionEndIncluding: "1.10.0" })] })
    expect(verdict.state).toBe("applicable")
  })

  test("an exact CPE version matches only that version", () => {
    const exact = range({ criteria: "cpe:2.3:a:f5:nginx:1.20.0:*:*:*:*:*:*:*" })
    expect(evaluateNvdApplicability({ component: normalizeComponent("nginx 1.20.0")!, ranges: [exact] }).state).toBe(
      "applicable",
    )
    expect(evaluateNvdApplicability({ component: normalizeComponent("nginx 1.21.0")!, ranges: [exact] }).state).toBe(
      "not_applicable",
    )
  })

  test("a versionless range is possible, not not-applicable", () => {
    const verdict = evaluateNvdApplicability({ component: nginx(), ranges: [range()] })
    expect(verdict.state).toBe("possible")
    expect(verdict.version_match).toBe("unknown")
    expect(verdict.confidence).toBe("low")
  })

  test("no observed version is possible when the product matches", () => {
    const component = normalizeComponent("nginx")!
    const verdict = evaluateNvdApplicability({
      component,
      ranges: [range({ versionEndExcluding: "1.21.1" })],
    })
    expect(verdict.state).toBe("possible")
    expect(verdict.version_match).toBe("unknown")
  })

  test("a non-vulnerable range never applies", () => {
    const verdict = evaluateNvdApplicability({
      component: nginx(),
      ranges: [range({ vulnerable: false, versionEndExcluding: "9.0" })],
    })
    expect(verdict.state).toBe("not_applicable")
  })

  test("a product mismatch with no mention is not-applicable", () => {
    const component = normalizeComponent("openssh 9.6")!
    const verdict = evaluateNvdApplicability({
      component,
      ranges: [range({ versionEndExcluding: "1.21.1" })],
      summary: "A flaw was found in nginx.",
    })
    expect(verdict.state).toBe("not_applicable")
  })

  test("a summary mention without a product range is possible intelligence", () => {
    const component = normalizeComponent("openssh 9.6")!
    const verdict = evaluateNvdApplicability({
      component,
      ranges: [range({ versionEndExcluding: "1.21.1" })],
      summary: "OpenSSH before 9.7 has an issue.",
    })
    expect(verdict.state).toBe("possible")
    expect(verdict.confidence).toBe("low")
  })

  test("nginx resolver preconditions downgrade a match to conditional", () => {
    const verdict = evaluateNvdApplicability({
      component: normalizeComponent("nginx 1.21.0")!,
      ranges: [range({ versionEndExcluding: "1.21.1" })],
      summary: "A resolver off-by-one in nginx allows memory corruption.",
    })
    expect(verdict.state).toBe("conditional")
    expect(verdict.preconditions.length).toBeGreaterThan(0)
    expect(verdict.verification_steps.some((step) => step.includes("resolver"))).toBe(true)
  })

  test("an apache HTTPD CPE matches via the alias candidate", () => {
    const component = normalizeComponent("apache 2.4.58")!
    const verdict = evaluateNvdApplicability({
      component,
      ranges: [
        {
          criteria: "cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*",
          vulnerable: true,
          versionStartIncluding: "2.4.0",
          versionEndExcluding: "2.4.59",
        },
      ],
    })
    expect(verdict.state).toBe("applicable")
    expect(verdict.version_match).toBe(true)
  })

  test("pre-release suffixes still compare deterministically", () => {
    const component = normalizeComponent("nginx 1.25.3")!
    expect(
      evaluateNvdApplicability({
        component,
        ranges: [range({ versionEndExcluding: "1.25.4" })],
      }).state,
    ).toBe("applicable")
  })
})
