import { describe, expect, test } from "bun:test"
import { decide, evaluate } from "@/permissions/permission"
import { Wildcard } from "@/support"

type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

const defaults: Rule[] = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "net", pattern: "*", action: "ask" },
  { permission: "vault", pattern: "*", action: "ask" },
  { permission: "question", pattern: "*", action: "deny" },
]

describe("permission evaluation order", () => {
  test("the last matching rule in a ruleset wins", () => {
    expect(evaluate("net", "*", defaults).action).toBe("ask")
    expect(evaluate("http_request", "*", defaults).action).toBe("allow")
  })

  test("an explicit deny in the ruleset is honoured", () => {
    expect(evaluate("question", "*", defaults).action).toBe("deny")
  })

  test("a wildcard permission rule matches any key", () => {
    expect(Wildcard.match("github:create_issue", "*")).toBe(true)
    expect(Wildcard.match("net", "net")).toBe(true)
    expect(Wildcard.match("net", "networks")).toBe(false)
  })

  test("matching does not depend on the platform (RISK-PERM-08)", () => {
    // Permission keys are identifiers: "Net" must not match the "net" rule.
    expect(Wildcard.match("Net", "net")).toBe(false)
    expect(Wildcard.match("net", "Net")).toBe(false)
  })
})

describe("stored approvals versus explicit denies (RISK-PERM-07)", () => {
  const approved: Rule[] = [{ permission: "net", pattern: "*", action: "allow" }]

  test("a stored approval satisfies an ask", () => {
    expect(decide(defaults, approved, "net", "*")).toBe("allow")
  })

  test("a stored approval never outranks an explicit deny", () => {
    const ruleset: Rule[] = [...defaults, { permission: "net", pattern: "*", action: "deny" }]
    expect(decide(ruleset, approved, "net", "*")).toBe("deny")
  })

  test("an unmatched permission still asks", () => {
    expect(decide(defaults, [], "vault", "*")).toBe("ask")
    expect(decide(defaults, [], "net", "*")).toBe("ask")
  })

  test("an explicit deny in the live ruleset is honoured without any approval", () => {
    expect(decide(defaults, [], "question", "*")).toBe("deny")
  })

  test("an explicit allow in the live ruleset is honoured", () => {
    expect(decide(defaults, [], "http_request", "*")).toBe("allow")
  })

  test("a stored approval for one tool does not allow another", () => {
    expect(decide(defaults, approved, "vault", "*")).toBe("ask")
  })
})
