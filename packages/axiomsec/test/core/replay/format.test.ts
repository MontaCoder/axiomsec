import { describe, expect, test } from "bun:test"
import { buildReplay, parseReplay, verifyBody, FORMAT } from "@/core/replay/format"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session"

const info = {
  id: "ses_replay",
  title: "Operation replay",
  time: { created: 1_700_000_000_000 },
} as unknown as Session.Info

const user = {
  info: {
    id: "msg_user",
    sessionID: "ses_replay",
    role: "user",
    time: { created: 1_700_000_000_000 },
    agent: "security",
    model: { providerID: "mock", modelID: "mock-model" },
  },
  parts: [
    {
      id: "prt_user",
      sessionID: "ses_replay",
      messageID: "msg_user",
      type: "text",
      text: "check Authorization: Bearer SUPERSECRET and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2",
    },
  ],
} as unknown as MessageV2.WithParts

const assistant = {
  info: {
    id: "msg_assistant",
    sessionID: "ses_replay",
    role: "assistant",
    time: { created: 1_700_000_001_000 },
    parentID: "msg_user",
    modelID: "mock-model",
    providerID: "mock",
    mode: "security",
    agent: "pentest",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [
    {
      id: "prt_assistant",
      sessionID: "ses_replay",
      messageID: "msg_assistant",
      type: "text",
      text: "The response was fetched.",
    },
    {
      id: "prt_tool",
      sessionID: "ses_replay",
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_1",
      tool: "http_request",
      state: {
        status: "completed",
        input: { url: "https://example.test", headers: { Authorization: "Bearer SUPERSECRET" } },
        output: { cookie: "session=SUPERSECRET" },
        title: "GET",
        metadata: {},
        time: { start: 1_700_000_001_500, end: 1_700_000_002_000 },
      },
    },
    {
      id: "prt_tool_error",
      sessionID: "ses_replay",
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_2",
      tool: "bash",
      state: {
        status: "error",
        input: { command: "curl -H 'Authorization: Bearer SUPERSECRET'" },
        error: "failed with Authorization: Bearer SUPERSECRET",
        metadata: {},
        time: { start: 1_700_000_003_000, end: 1_700_000_003_500 },
      },
    },
  ],
} as unknown as MessageV2.WithParts

describe("replay building", () => {
  const built = buildReplay({ info, messages: [user, assistant], redact: "off" })

  test("emits a header, ordered events and a trailer", () => {
    const parsed = parseReplay(built.lines.join("\n"))
    expect(parsed.header).toMatchObject({
      type: "header",
      format: FORMAT,
      id: "ses_replay",
      scope: "session",
      title: "Operation replay",
      kind: "pentest",
      model: { provider: "mock", id: "mock-model" },
      redacted: false,
    })
    expect(parsed.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(parsed.events[0]).toMatchObject({ event: "message", data: { role: "user" } })
    expect(parsed.events.some((event) => event.event === "tool_call")).toBe(true)
    expect(parsed.events.some((event) => event.event === "tool_result")).toBe(true)
    expect(parsed.trailer).toMatchObject({ type: "trailer", events: 6, signed: false, signature: null })
    expect(parsed.trailer.duration_ms).toBe(3_500)
  })

  test("the body hash verifies exactly", () => {
    const result = verifyBody(built.lines.join("\n"))
    expect(result.ok).toBe(true)
    expect(result.actual).toBe(built.trailer.sha256_body)
  })

  test("any body mutation invalidates the hash", () => {
    const lines = [...built.lines]
    lines[1] = (lines[1] ?? "").replace("SUPERSECRET", "tampered")
    expect(verifyBody(lines.join("\n")).ok).toBe(false)
  })

  test("unredacted mode preserves secrets by design", () => {
    expect(built.lines.join("\n")).toContain("SUPERSECRET")
    expect(built.header.redacted).toBe(false)
  })

  test("tool results carry status and duration", () => {
    const parsed = parseReplay(built.lines.join("\n"))
    const result = parsed.events.find((event) => event.event === "tool_result" && event.data["call_id"] === "call_1")
    expect(result?.data["status"]).toBe("completed")
    expect(result?.data["duration_ms"]).toBe(500)
  })
})

describe("replay redaction", () => {
  const built = buildReplay({ info, messages: [user, assistant], redact: "on" })
  const text = built.lines.join("\n")

  test("the title and every secret-bearing field are redacted", () => {
    expect(built.header.title).toBe("[redacted:title]")
    expect(built.header.redacted).toBe(true)
    expect(text).not.toContain("SUPERSECRET")
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9")
    expect(text.toLowerCase()).toContain("[redacted:header:authorization]")
  })

  test("tool errors are redacted too", () => {
    const parsed = parseReplay(text)
    const error = parsed.events.find(
      (event) => event.event === "tool_result" && event.data["call_id"] === "call_2",
    )
    expect(error?.data["status"]).toBe("error")
    expect(error?.data["error"]).not.toContain("SUPERSECRET")
  })

  test("redacted replay is still parseable and hash-verifiable", () => {
    const parsed = parseReplay(text)
    expect(parsed.events).toHaveLength(6)
    expect(verifyBody(text).ok).toBe(true)
  })
})

describe("replay parsing rejects malformed input", () => {
  const built = buildReplay({ info, messages: [user], redact: "off" })

  test("too few lines", () => {
    expect(() => parseReplay("{}")).toThrow(/too short/)
  })

  test("missing header", () => {
    expect(() => parseReplay(['{"type":"event"}', '{"type":"trailer"}'].join("\n"))).toThrow(/missing header/)
  })

  test("unsupported format version", () => {
    const header = JSON.parse(built.lines[0])
    header.format = "axiomsec/999"
    expect(() => parseReplay([JSON.stringify(header), built.lines.at(-1)!].join("\n"))).toThrow(/unsupported format/)
  })

  test("missing trailer", () => {
    expect(() => parseReplay([built.lines[0], '{"type":"event"}'].join("\n"))).toThrow(/missing trailer/)
  })

  test("a non-event body line is rejected with its line number", () => {
    const lines = [...built.lines]
    lines.splice(1, 0, JSON.stringify({ type: "header" }))
    expect(() => parseReplay(lines.join("\n"))).toThrow(/line 2: expected event/)
  })
})
