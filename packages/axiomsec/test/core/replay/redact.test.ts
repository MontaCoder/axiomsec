import { describe, expect, test } from "bun:test"
import { redactString, redactValue } from "@/core/replay/redact"

describe("structured redaction (RISK-SECRET-01 / RISK-SECRET-04)", () => {
  test("a flat sensitive key is redacted", () => {
    expect(redactValue({ token: "SUPERSECRET" }, "on")).toEqual({ token: "[redacted:secret:token]" })
    expect(redactValue({ password: "hunter2" }, "on")).toEqual({ password: "[redacted:secret:password]" })
  })

  test("a sensitive key whose value is an object is redacted as a whole", () => {
    const out = redactValue({ token: { value: "SUPERSECRET-TOKEN" } }, "on") as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain("SUPERSECRET-TOKEN")
    expect(out.token).toBe("[redacted:secret:token]")
  })

  test("a sensitive key whose value is an array is redacted as a whole", () => {
    const out = redactValue({ secret: ["a", "b"] }, "on") as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain("\"a\"")
    expect(out.secret).toBe("[redacted:secret:secret]")
  })

  test("a nested sensitive key is still redacted", () => {
    expect(redactValue({ credentials: { secret: "x" } }, "on")).toEqual({
      credentials: { secret: "[redacted:secret:secret]" },
    })
  })

  test("a non-sensitive key keeps its structure", () => {
    expect(redactValue({ user: { id: 1 } }, "on")).toEqual({ user: { id: 1 } })
  })

  test("a header pair object is redacted by name", () => {
    const out = redactValue({ name: "Authorization", value: "Bearer abc" }, "on") as Record<string, unknown>
    expect(out.value).toBe("[redacted:header:Authorization]")
  })

  test("mode off changes nothing", () => {
    expect(redactValue({ token: "x" }, "off")).toEqual({ token: "x" })
    expect(redactString("Authorization=Bearer abc", "off")).toBe("Authorization=Bearer abc")
  })
})

describe("text redaction", () => {
  test("a header line is redacted", () => {
    expect(redactString("Authorization: Bearer abc123", "on")).toBe("Authorization: [redacted:header:authorization]")
    expect(redactString("Cookie: session=abc123", "on")).toBe("Cookie: [redacted:header:cookie]")
  })

  test("an unquoted authorization assignment is redacted", () => {
    const out = redactString("Authorization=Bearer abc123xyz", "on")
    expect(out).not.toContain("abc123xyz")
  })

  test("an unquoted cookie assignment is redacted", () => {
    const out = redactString("Cookie=session=xyz123", "on")
    expect(out).not.toContain("xyz123")
  })

  test("a secret assignment is redacted", () => {
    expect(redactString("token=abc123", "on")).toBe("token=[redacted:secret]")
    expect(redactString("api_key=abc123", "on")).not.toContain("abc123")
    expect(redactString('password="abc123"', "on")).not.toContain("abc123")
  })

  test("a JWT is redacted", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    expect(redactString(`token is ${jwt}`, "on")).not.toContain("eyJhbGciOiJIUzI1NiJ9")
  })

  test("an already redacted placeholder is not redacted twice", () => {
    const once = redactString("Authorization: Bearer abc123", "on")
    expect(redactString(once, "on")).toBe(once)
  })

  test("ordinary prose is untouched", () => {
    expect(redactString("the authorization was denied", "on")).toBe("the authorization was denied")
  })
})
