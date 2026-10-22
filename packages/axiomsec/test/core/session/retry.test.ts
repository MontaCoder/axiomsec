import { describe, expect, test } from "bun:test"
import { SessionRetry } from "@/session/retry"

function apiError(input: {
  message?: string
  statusCode?: number
  isRetryable?: boolean
  responseBody?: string
  responseHeaders?: Record<string, string>
}): SessionRetry.Err {
  return {
    name: "APIError",
    data: {
      message: input.message ?? "rate limited",
      statusCode: input.statusCode,
      isRetryable: input.isRetryable ?? true,
      responseBody: input.responseBody,
      responseHeaders: input.responseHeaders,
    },
  } as SessionRetry.Err
}

describe("retry classification (RISK-TIME-03)", () => {
  test("a transient 429 is retryable", () => {
    const error = apiError({ statusCode: 429, isRetryable: true })
    expect(SessionRetry.retryable(error)).toBeTruthy()
    expect(SessionRetry.shouldRetry(error, 0)).toBeTruthy()
  })

  test("a daily free-tier quota is permanent, not retried", () => {
    const error = apiError({
      statusCode: 429,
      isRetryable: true,
      responseBody: JSON.stringify({
        error: {
          message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
          metadata: { limit_source: "openrouter_free_tier_daily" },
        },
      }),
    })
    expect(SessionRetry.retryable(error)).toBeUndefined()
    expect(SessionRetry.shouldRetry(error, 1)).toBeUndefined()
  })

  test("an exhausted credit balance is permanent", () => {
    for (const message of ["insufficient credits", "insufficient_quota", "quota exceeded"]) {
      expect(SessionRetry.retryable(apiError({ statusCode: 402, message }))).toBeUndefined()
    }
  })

  test("5xx is retried even when the SDK marks it non-retryable", () => {
    expect(SessionRetry.retryable(apiError({ statusCode: 503, isRetryable: false }))).toBeTruthy()
  })

  test("4xx client errors without a rate limit signal are not retried", () => {
    expect(SessionRetry.retryable(apiError({ statusCode: 400, isRetryable: false }))).toBeUndefined()
    expect(SessionRetry.retryable(apiError({ statusCode: 401, isRetryable: false }))).toBeUndefined()
  })

  test("the attempt budget is bounded", () => {
    const error = apiError({ statusCode: 429, isRetryable: true })
    expect(SessionRetry.shouldRetry(error, SessionRetry.RETRY_MAX_ATTEMPTS - 1)).toBeTruthy()
    expect(SessionRetry.shouldRetry(error, SessionRetry.RETRY_MAX_ATTEMPTS)).toBeUndefined()
    expect(SessionRetry.shouldRetry(error, SessionRetry.RETRY_MAX_ATTEMPTS + 1)).toBeUndefined()
  })

  test("the free-usage upsell is retried with a specific message", () => {
    const error = apiError({
      statusCode: 429,
      responseBody: JSON.stringify({ error: { type: "FreeUsageLimitError" } }),
    })
    expect(SessionRetry.retryable(error)).toBe(SessionRetry.GO_UPSELL_MESSAGE)
  })

  test("plain rate-limit text is retryable", () => {
    const error = { name: "UnknownError", data: { message: "Too many requests, slow down" } } as SessionRetry.Err
    expect(SessionRetry.retryable(error)).toBe("Too many requests, slow down")
  })
})

describe("retry delay", () => {
  test("honours retry-after-ms and retry-after", () => {
    expect(SessionRetry.delay(1, apiError({ responseHeaders: { "retry-after-ms": "1500" } }) as never)).toBe(1500)
    expect(SessionRetry.delay(1, apiError({ responseHeaders: { "retry-after": "2" } }) as never)).toBe(2000)
  })

  test("falls back to exponential backoff", () => {
    expect(SessionRetry.delay(1)).toBe(2000)
    expect(SessionRetry.delay(2)).toBe(4000)
    expect(SessionRetry.delay(3)).toBe(8000)
  })

  test("caps headerless delays", () => {
    expect(SessionRetry.delay(20)).toBe(SessionRetry.RETRY_MAX_DELAY_NO_HEADERS)
  })

  test("a header delay is capped at the platform maximum", () => {
    expect(
      SessionRetry.delay(1, apiError({ responseHeaders: { "retry-after": "999999999" } }) as never),
    ).toBe(SessionRetry.RETRY_MAX_DELAY)
  })
})
