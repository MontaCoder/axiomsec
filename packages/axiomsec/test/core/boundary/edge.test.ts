import { describe, expect, test } from "bun:test"
import { evaluate } from "@/core/boundary/evaluate"

const b = (input: { default?: "allow" | "deny" | "ask"; in_scope?: string[]; out_of_scope?: string[] }) => ({
  default: input.default ?? ("ask" as const),
  in_scope: input.in_scope ?? [],
  out_of_scope: input.out_of_scope ?? [],
})

describe("boundary evaluation degrades safely", () => {
  test("undefined and non-object boundaries ask", () => {
    expect(evaluate(undefined, { kind: "host", value: "example.com" })).toEqual({
      mode: "ask",
      reason: "no boundary defined",
    })
    for (const broken of [null, "yes", 42, [], { default: "sometimes", in_scope: 1 }]) {
      const decision = evaluate(broken, { kind: "host", value: "example.com" })
      expect(decision.mode).toBe("ask")
    }
  })

  test("an empty boundary falls back to the default with a distinct reason", () => {
    expect(evaluate(b({ default: "allow" }), { kind: "host", value: "x.test" })).toEqual({
      mode: "allow",
      reason: "no boundary defined",
    })
    expect(evaluate(b({ default: "deny", in_scope: ["a.test"] }), { kind: "host", value: "x.test" })).toEqual({
      mode: "deny",
      reason: "no pattern matched",
    })
  })

  test("an empty pattern never matches", () => {
    expect(evaluate(b({ in_scope: ["", " "] }), { kind: "host", value: "" }).mode).toBe("ask")
  })
})

describe("URL matching", () => {
  test("scheme wildcard matches subdomains but not suffix tricks", () => {
    const boundary = b({ in_scope: ["https://*.example.com"] })
    expect(evaluate(boundary, { kind: "url", value: "https://api.example.com/x" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "url", value: "https://deep.api.example.com/" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "url", value: "https://example.com.evil.test/" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "url", value: "https://notexample.com/" }).mode).toBe("ask")
  })

  test("scheme-qualified patterns require the same protocol, host and effective port", () => {
    const boundary = b({ in_scope: ["http://127.0.0.1:8080"] })
    expect(evaluate(boundary, { kind: "url", value: "http://127.0.0.1:8080/" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "url", value: "http://127.0.0.1:8081/" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "url", value: "https://127.0.0.1:8080/" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "url", value: "http://user:pass@127.0.0.1:8080/" }).mode).toBe("allow")
  })

  test("a path prefix does not match a sibling prefix or a traversal-normalised path", () => {
    const boundary = b({ in_scope: ["https://example.com/api"] })
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/api/../admin" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/API" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/api?x=1" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/api#frag" }).mode).toBe("allow")
  })

  test("query and fragment in a pattern do not widen the path match", () => {
    const boundary = b({ in_scope: ["https://example.com/login?next=/admin"] })
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/login" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/login/other" }).mode).toBe("allow")
  })

  test("path globs do not cross a slash with one star", () => {
    const boundary = b({ in_scope: ["https://example.com/api/*/admin"] })
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/api/v2/admin" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/api/v2/x/admin" }).mode).toBe("ask")
    const deep = b({ in_scope: ["https://example.com/api/**"] })
    expect(evaluate(deep, { kind: "url", value: "https://example.com/api/v2/x/admin" }).mode).toBe("allow")
  })

  test("malformed URLs never match and never throw", () => {
    const boundary = b({ in_scope: ["not a url", "https://example.com"] })
    expect(evaluate(boundary, { kind: "url", value: "not a url" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "url", value: "javascript:alert(1)" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "url", value: "" }).mode).toBe("ask")
  })

  test("a scheme-less host pattern is case-insensitive on the hostname", () => {
    const boundary = b({ in_scope: ["Example.COM"] })
    expect(evaluate(boundary, { kind: "url", value: "https://example.com/" }).mode).toBe("allow")
  })

  test("ws and wss use their effective ports", () => {
    expect(evaluate(b({ in_scope: ["ws://example.com:80"] }), { kind: "url", value: "ws://example.com/" }).mode).toBe(
      "allow",
    )
    expect(evaluate(b({ in_scope: ["wss://example.com:443"] }), { kind: "url", value: "wss://example.com/" }).mode).toBe(
      "allow",
    )
    expect(evaluate(b({ in_scope: ["wss://example.com:443"] }), { kind: "url", value: "wss://example.com:8443/" }).mode).toBe(
      "ask",
    )
  })
})

describe("host, path and raw requests", () => {
  test("host wildcard does not match the apex", () => {
    const boundary = b({ in_scope: ["*.internal.test"] })
    expect(evaluate(boundary, { kind: "host", value: "db.internal.test" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "host", value: "internal.test" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "host", value: "evilinternal.test" }).mode).toBe("ask")
  })

  test("host matching is case-insensitive because DNS names are", () => {
    const boundary = b({ in_scope: ["db.internal.test"] })
    expect(evaluate(boundary, { kind: "host", value: "DB.internal.test" }).mode).toBe("allow")
    expect(evaluate(b({ out_of_scope: ["DB.INTERNAL.TEST"] }), { kind: "host", value: "db.internal.test" }).mode).toBe(
      "deny",
    )
  })

  test("path patterns support globs and subtree prefixes", () => {
    const boundary = b({ in_scope: ["/srv/app", "/var/log/*.log"] })
    expect(evaluate(boundary, { kind: "path", value: "/srv/app/secrets.env" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "path", value: "/srv/application" }).mode).toBe("ask")
    expect(evaluate(boundary, { kind: "path", value: "/var/log/nginx.log" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "path", value: "/var/log/nginx/access.log" }).mode).toBe("ask")
  })

  test("raw requests use the same matching rules", () => {
    const boundary = b({ in_scope: ["target-*"] })
    expect(evaluate(boundary, { kind: "raw", value: "target-prod" }).mode).toBe("allow")
    expect(evaluate(boundary, { kind: "raw", value: "prod-target" }).mode).toBe("ask")
  })

  test("out_of_scope wins for every request kind", () => {
    for (const request of [
      { kind: "url" as const, value: "https://example.com/" },
      { kind: "host" as const, value: "example.com" },
      { kind: "path" as const, value: "/srv/example" },
      { kind: "raw" as const, value: "example" },
    ]) {
      const pattern = request.kind === "url" ? "https://example.com" : request.value
      expect(evaluate(b({ in_scope: ["*"], out_of_scope: [pattern] }), request).mode).toBe("deny")
    }
  })
})
