import { describe, expect, test } from "bun:test"
import { evaluate } from "@/core/boundary/evaluate"

const boundary = (input: { default?: "allow" | "deny" | "ask"; in_scope?: string[]; out_of_scope?: string[] }) => ({
  default: input.default ?? ("ask" as const),
  in_scope: input.in_scope ?? [],
  out_of_scope: input.out_of_scope ?? [],
})

const url = (value: string) => evaluate(boundary({ in_scope: ["https://example.com"] }), { kind: "url", value }).mode

describe("boundary scheme patterns (RISK-SCOPE-04)", () => {
  test("exact origin is allowed", () => {
    expect(url("https://example.com/")).toBe("allow")
    expect(url("https://example.com")).toBe("allow")
  })

  test("hostname suffix is not allowed", () => {
    expect(url("https://example.com.evil.test/")).toBe("ask")
  })

  test("userinfo trick is not allowed", () => {
    expect(url("https://example.com@evil.test/")).toBe("ask")
  })

  test("different port is not allowed", () => {
    expect(url("https://example.com:8443/")).toBe("ask")
  })

  test("different scheme is not allowed", () => {
    expect(url("http://example.com/")).toBe("ask")
  })

  test("default ports are normalized", () => {
    const b = boundary({ in_scope: ["https://example.com:443"] })
    expect(evaluate(b, { kind: "url", value: "https://example.com/" }).mode).toBe("allow")
  })
})

describe("boundary path prefix matching", () => {
  test("path prefix matches the subtree but not a sibling prefix", () => {
    const b = boundary({ in_scope: ["https://example.com/api"] })
    expect(evaluate(b, { kind: "url", value: "https://example.com/api" }).mode).toBe("allow")
    expect(evaluate(b, { kind: "url", value: "https://example.com/api/" }).mode).toBe("allow")
    expect(evaluate(b, { kind: "url", value: "https://example.com/api/v2" }).mode).toBe("allow")
    expect(evaluate(b, { kind: "url", value: "https://example.com/apix" }).mode).toBe("ask")
  })

  test("path glob is honoured", () => {
    const b = boundary({ in_scope: ["https://example.com/api/*/admin"] })
    expect(evaluate(b, { kind: "url", value: "https://example.com/api/v2/admin" }).mode).toBe("allow")
    expect(evaluate(b, { kind: "url", value: "https://example.com/api/v2/user" }).mode).toBe("ask")
  })
})

describe("boundary host patterns", () => {
  test("wildcard host matches a subdomain but not the apex", () => {
    const b = boundary({ in_scope: ["*.example.com"] })
    expect(evaluate(b, { kind: "url", value: "https://api.example.com/" }).mode).toBe("allow")
    expect(evaluate(b, { kind: "url", value: "https://example.com/" }).mode).toBe("ask")
    expect(evaluate(b, { kind: "url", value: "https://notexample.com/" }).mode).toBe("ask")
  })

  test("host request kind", () => {
    const b = boundary({ in_scope: ["127.0.0.1"] })
    expect(evaluate(b, { kind: "host", value: "127.0.0.1" }).mode).toBe("allow")
    expect(evaluate(b, { kind: "host", value: "127.0.0.2" }).mode).toBe("ask")
  })
})

describe("boundary precedence", () => {
  test("out_of_scope wins over in_scope", () => {
    const b = boundary({ in_scope: ["127.0.0.1"], out_of_scope: ["127.0.0.1"] })
    expect(evaluate(b, { kind: "host", value: "127.0.0.1" }).mode).toBe("deny")
  })

  test("no patterns falls back to the configured default", () => {
    expect(evaluate(boundary({ default: "allow" }), { kind: "host", value: "example.com" }).mode).toBe("allow")
    expect(evaluate(boundary({ default: "deny" }), { kind: "host", value: "example.com" }).mode).toBe("deny")
  })
})
