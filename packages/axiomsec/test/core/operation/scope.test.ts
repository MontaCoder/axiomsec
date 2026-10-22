import { describe, expect, test } from "bun:test"
import { parseScope } from "@/core/operation/scope"
import { evaluate } from "@/core/boundary/evaluate"

describe("legacy axiomsec.md scope parser", () => {
  test("parses in and out entries and trims whitespace", () => {
    const boundary = parseScope(
      [
        "# Operation",
        "## Scope",
        "  - in: https://example.com",
        "- out: 10.0.0.0/8 ",
        "- in:",
        "- out:",
      ].join("\n"),
    )
    expect(boundary.in_scope).toEqual(["https://example.com"])
    expect(boundary.out_of_scope).toEqual(["10.0.0.0/8"])
    expect(boundary.default).toBe("ask")
  })

  test("is case-insensitive for the heading and keys", () => {
    const boundary = parseScope("## SCOPE\n-IN: example.com\n-OUT: bad.test\n")
    expect(boundary.in_scope).toEqual(["example.com"])
    expect(boundary.out_of_scope).toEqual(["bad.test"])
  })

  test("stops at the next level-two heading", () => {
    const boundary = parseScope(["## Scope", "- in: example.com", "## Notes", "- in: ignored.test"].join("\n"))
    expect(boundary.in_scope).toEqual(["example.com"])
  })

  test("a level-three heading does not end the section", () => {
    const boundary = parseScope(["## Scope", "### Targets", "- in: example.com", "## Notes", "- out: x"].join("\n"))
    expect(boundary.in_scope).toEqual(["example.com"])
    expect(boundary.out_of_scope).toEqual([])
  })

  test("an empty scope section allows by default", () => {
    expect(parseScope("## Scope\n\n## Next\n- in: ignored").default).toBe("allow")
    expect(parseScope("# Operation\nNo scope section").default).toBe("allow")
  })

  test("a heading that merely starts with 'scope' does not start the section", () => {
    expect(parseScope("## Scoped targets\n- in: example.com").in_scope).toEqual([])
  })

  test("parsed scope plugs into the boundary evaluator", () => {
    const boundary = parseScope("## Scope\n- in: https://example.com/api\n- out: https://example.com/api/private")
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/api/v1" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/api/private/x" }).mode).toBe("deny")
    expect(evaluate(boundary, { kind: "url", value: "https://other.test/" }).mode).toBe("ask")
  })
})
