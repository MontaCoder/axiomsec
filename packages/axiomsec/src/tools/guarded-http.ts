import { Effect, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Guard, ScopeDeniedError } from "@/core/boundary"
import type * as Tool from "./tool"

const SENSITIVE_REDIRECT_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "host"])
const BODY_REDIRECT_HEADERS = new Set(["content-type", "content-length"])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function redirectRequest(
  previous: HttpClientRequest.HttpClientRequest,
  status: number,
  nextUrl: string,
): HttpClientRequest.HttpClientRequest {
  const previousUrl = new URL(previous.url)
  const next = new URL(nextUrl)
  const dropBody =
    status === 303 || ((status === 301 || status === 302) && previous.method !== "GET" && previous.method !== "HEAD")
  const headers: Record<string, string> = { ...previous.headers }
  if (previousUrl.origin !== next.origin) {
    for (const name of Object.keys(headers)) {
      if (SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase())) delete headers[name]
    }
  }
  if (!dropBody) return HttpClientRequest.setUrl(previous, nextUrl)
  for (const name of Object.keys(headers)) {
    if (BODY_REDIRECT_HEADERS.has(name.toLowerCase())) delete headers[name]
  }
  return HttpClientRequest.get(nextUrl).pipe(HttpClientRequest.setHeaders(headers))
}

function drain(response: HttpClientResponse.HttpClientResponse) {
  return Stream.runDrain(response.stream).pipe(Effect.catch(() => Effect.void))
}

function drainWithBudget(response: HttpClientResponse.HttpClientResponse, remaining: number | undefined) {
  if (remaining === undefined) return drain(response)
  return drain(response).pipe(
    Effect.timeoutOrElse({
      duration: Math.max(1, remaining),
      orElse: () => Effect.void,
    }),
  )
}

export type GuardedHttpInput = {
  client: HttpClient.HttpClient
  request: HttpClientRequest.HttpClientRequest
  workspace: string
  slug?: string
  ctx: Pick<Tool.Context, "ask">
  followRedirects: boolean
  maxRedirects?: number
  timeoutMs?: number
}

export function execute(input: GuardedHttpInput) {
  return Effect.gen(function* () {
    let request = input.request
    let redirects = 0
    const maxRedirects = input.maxRedirects ?? 10
    let deadline = input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs

    while (true) {
      const remaining = deadline === undefined ? undefined : deadline - Date.now()
      if (remaining !== undefined && remaining <= 0) {
        throw new Error(`Request timed out after ${input.timeoutMs}ms`)
      }
      const response = yield* (remaining === undefined
        ? input.client.execute(request)
        : input.client.execute(request).pipe(
            Effect.timeoutOrElse({
              duration: remaining,
              orElse: () => Effect.die(new Error(`Request timed out after ${input.timeoutMs}ms`)),
            }),
          ))
      const location = response.headers.location
      if (!input.followRedirects || !REDIRECT_STATUSES.has(response.status) || !location) {
        return response
      }
      if (redirects >= maxRedirects) {
        yield* drainWithBudget(response, remaining)
        throw new Error(`too many redirects (max ${maxRedirects})`)
      }
      redirects += 1
      const nextUrl = new URL(location, request.url).toString()
      const decision = yield* Effect.tryPromise({
        try: () => Guard.checkUrl(input.workspace, nextUrl, input.slug),
        catch: (error) => (error instanceof ScopeDeniedError ? error : new Error(String(error))),
      })
      if (decision.mode === "ask") {
        const askStarted = Date.now()
        yield* input.ctx.ask(Guard.approvalRequest(decision, { kind: "url", value: nextUrl }))
        if (deadline !== undefined) deadline += Date.now() - askStarted
      }
      const afterAsk = deadline === undefined ? undefined : deadline - Date.now()
      yield* drainWithBudget(response, afterAsk)
      request = redirectRequest(request, response.status, nextUrl)
    }
  }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
}
