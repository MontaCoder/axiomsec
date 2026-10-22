import { describe, expect, test } from "bun:test"
import { evaluate } from "@/permissions/permission"
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
})
