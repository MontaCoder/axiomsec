import { expect } from "bun:test"

export type ToolCall = {
  name: string
  arguments: Record<string, unknown>
}

export type Turn =
  | { kind: "text"; content: string }
  | { kind: "tool"; call: ToolCall }

export type MockProvider = {
  /** Base URL to configure as the provider endpoint. */
  baseURL: string
  /** How many agent requests the model endpoint received. */
  calls(): number
  /** The conversation the model was shown, one entry per agent request. */
  transcripts(): Array<Array<Record<string, unknown>>>
  close(): void
}

function chunk(body: unknown) {
  return `data: ${JSON.stringify(body)}\n\n`
}

/**
 * A request from the background title agent rather than the operator's agent.
 * The session title is generated on a separate model call, so it must not
 * consume a turn from the script the test wrote.
 */
function isTitleRequest(messages: Array<Record<string, unknown>>): boolean {
  const system = messages.find((message) => message.role === "system")
  const content = typeof system?.content === "string" ? system.content : ""
  return /title generator|thread title/i.test(content)
}

/**
 * A scripted OpenAI-compatible streaming endpoint.
 *
 * The script is consumed one turn per agent request, so a test can drive a
 * full agent loop: ask for a tool call, let the agent run it, then finish with
 * text. The last turn repeats if the agent asks for more.
 */
export function mockProvider(turns: Turn[]): MockProvider {
  const transcripts: Array<Array<Record<string, unknown>>> = []
  let index = 0

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json().catch(() => ({}))) as { messages?: Array<Record<string, unknown>> }
      const messages = body.messages ?? []

      if (isTitleRequest(messages)) {
        // The title agent only ever needs a short string.
        const sse =
          chunk({
            id: "1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: "test session" }, finish_reason: null }],
          }) +
          chunk({
            id: "1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }) +
          "data: [DONE]\n\n"
        return new Response(sse, { headers: { "content-type": "text/event-stream" } })
      }

      transcripts.push(messages)
      const turn = turns[Math.min(index, turns.length - 1)]
      index += 1

      let sse: string
      if (turn.kind === "text") {
        sse =
          chunk({
            id: "1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: turn.content }, finish_reason: null }],
          }) +
          chunk({
            id: "1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })
      } else {
        sse =
          chunk({
            id: "1",
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${index}`,
                      type: "function",
                      function: { name: turn.call.name, arguments: JSON.stringify(turn.call.arguments) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }) +
          chunk({
            id: "1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          })
      }
      sse += "data: [DONE]\n\n"
      return new Response(sse, { headers: { "content-type": "text/event-stream" } })
    },
  })

  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    calls: () => index,
    transcripts: () => transcripts,
    close: () => server.stop(true),
  }
}

/** A provider config that points the agent at a mock endpoint. */
export function mockConfig(baseURL: string) {
  return {
    model: "mock/mock-model",
    provider: {
      mock: {
        id: "mock",
        name: "Mock",
        env: ["MOCK_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL, apiKey: "mock" },
        models: {
          "mock-model": {
            name: "Mock",
            tool_call: true,
            limit: { context: 8192, output: 1024 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }
}

/** Parse the `--format json` event stream the CLI emits. */
export function parseEvents(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // Not an event line.
    }
  }
  return events
}

/** The text a run produced, concatenated from its text events. */
export function textOf(events: Array<Record<string, unknown>>): string {
  return events
    .filter((event) => event.type === "text")
    .map((event) => {
      const part = event.part as { text?: string } | undefined
      return part?.text ?? ""
    })
    .join("")
}

export function expectText(events: Array<Record<string, unknown>>, expected: string) {
  expect(textOf(events)).toContain(expected)
}
