import { describe, expect, test } from "bun:test"
import {
  decide,
  disabled,
  evaluate,
  fromConfig,
  merge,
  supportsToolWideAlways,
  type Ruleset,
} from "@/permissions/permission"
import { BashArity } from "@/permissions/arity"

describe("config rulesets", () => {
  test("a scalar action becomes a tool-wide rule", () => {
    expect(fromConfig({ net: "deny" } as never)).toEqual([{ permission: "net", pattern: "*", action: "deny" }])
  })

  test("an object action maps patterns to rules", () => {
    const rules = fromConfig({ read: { "*.env": "ask", "docs/*": "allow" } } as never)
    expect(rules).toEqual([
      { permission: "read", pattern: "*.env", action: "ask" },
      { permission: "read", pattern: "docs/*", action: "allow" },
    ])
  })

  test("tilde and $HOME patterns are expanded", () => {
    const rules = fromConfig({ read: { "~/.ssh/*": "ask", "$HOME/secrets": "deny" } } as never)
    expect(rules[0]?.pattern).not.toContain("~")
    expect(rules[0]?.pattern.endsWith("/.ssh/*")).toBe(true)
    expect(rules[1]?.pattern.endsWith("/secrets")).toBe(true)
  })

  test("merge flattens rulesets in order", () => {
    const a: Ruleset = [{ permission: "a", pattern: "*", action: "ask" }]
    const b: Ruleset = [{ permission: "b", pattern: "*", action: "deny" }]
    expect(merge(a, b)).toEqual([...a, ...b])
  })

  test("tool-wide always is limited to tools whose permission is about the whole tool", () => {
    expect(supportsToolWideAlways("browser")).toBe(true)
    expect(supportsToolWideAlways("net")).toBe(true)
    expect(supportsToolWideAlways("edit")).toBe(false)
    expect(supportsToolWideAlways("finding")).toBe(false)
  })
})

describe("tool disabling", () => {
  const denyEdit: Ruleset = [{ permission: "edit", pattern: "*", action: "deny" }]

  test("a tool-wide deny removes edit family tools", () => {
    expect([...disabled(["write", "edit", "apply_patch", "read"], denyEdit)]).toEqual([
      "write",
      "edit",
      "apply_patch",
    ])
  })

  test("a scoped deny pattern does not remove the tool", () => {
    expect([...disabled(["bash"], [{ permission: "bash", pattern: "rm *", action: "deny" }])]).toEqual([])
  })

  test("a later allow for the same permission wins over an earlier deny", () => {
    const rules: Ruleset = [
      { permission: "read", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ]
    expect([...disabled(["read"], rules)]).toEqual([])
  })

  test("an unrelated deny does not remove the tool", () => {
    expect([...disabled(["net"], denyEdit)]).toEqual([])
  })
})

describe("rule evaluation", () => {
  test("last matching rule wins across merged rulesets", () => {
    const rules: Ruleset = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "net", pattern: "*", action: "ask" },
      { permission: "net", pattern: "db.internal:5432", action: "allow" },
    ]
    expect(evaluate("net", "db.internal:5432", rules).action).toBe("allow")
    expect(evaluate("net", "web.internal:443", rules).action).toBe("ask")
    expect(evaluate("http_request", "https://x", rules).action).toBe("allow")
  })

  test("no match defaults to ask with a wildcard rule", () => {
    expect(evaluate("vault", "get", [])).toEqual({ action: "ask", permission: "vault", pattern: "*" })
  })

  test("wildcards do not cross the separator unless written to", () => {
    const rules: Ruleset = [{ permission: "net", pattern: "db.*", action: "deny" }]
    expect(evaluate("net", "db.internal", rules).action).toBe("deny")
    expect(evaluate("net", "db.internal:5432", rules).action).toBe("deny")
    expect(evaluate("net", "web.internal", rules).action).toBe("ask")
  })
})

describe("stored approvals", () => {
  const live: Ruleset = [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "net", pattern: "*", action: "ask" },
  ]
  const approved: Ruleset = [{ permission: "net", pattern: "*", action: "allow" }]

  test("approval satisfies ask but not deny", () => {
    expect(decide(live, approved, "net", "*")).toBe("allow")
    const denied: Ruleset = [...live, { permission: "net", pattern: "*", action: "deny" }]
    expect(decide(denied, approved, "net", "*")).toBe("deny")
  })

  test("a scoped approval does not authorize another pattern", () => {
    const scoped: Ruleset = [{ permission: "net", pattern: "tcp:127.0.0.1:80", action: "allow" }]
    expect(decide(live, scoped, "net", "tcp:127.0.0.1:80")).toBe("allow")
    expect(decide(live, scoped, "net", "tcp:127.0.0.1:81")).toBe("ask")
  })

  test("approval never changes an explicit allow", () => {
    expect(decide(live, [], "edit", "src/a.ts")).toBe("allow")
  })
})

describe("bash arity", () => {
  test("recognises common multi-word commands", () => {
    expect(BashArity.prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"])
    expect(BashArity.prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"])
    expect(BashArity.prefix(["docker", "compose", "up"])).toEqual(["docker", "compose", "up"])
    expect(BashArity.prefix(["rm", "-rf", "/tmp/x"])).toEqual(["rm"])
  })

  test("unknown commands fall back to one token", () => {
    expect(BashArity.prefix(["customcmd", "arg"])).toEqual(["customcmd"])
    expect(BashArity.prefix([])).toEqual([])
  })
})
