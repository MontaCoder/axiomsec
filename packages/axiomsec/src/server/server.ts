import { generateSpecs } from "hono-openapi"
import { Hono } from "hono"
import { adapter } from "#hono"
import { lazy } from "@/support/lazy"
import { AuthMiddleware, CompressionMiddleware, CorsMiddleware, ErrorMiddleware, LoggerMiddleware } from "./middleware"
import { InstanceRoutes } from "./instance"
import { initProjectors } from "./projectors"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

initProjectors()

export namespace Server {
  export type Listener = {
    hostname: string
    port: number
    url: URL
    stop: (close?: boolean) => Promise<void>
  }

  export const Default = lazy(() => create({}))

  function create(opts: { cors?: string[] }) {
    const app = new Hono()
    const runtime = adapter.create(app)

    return {
      app: app
        .onError(ErrorMiddleware)
        .use(AuthMiddleware)
        .use(LoggerMiddleware)
        .use(CompressionMiddleware)
        .use(CorsMiddleware(opts))
        .route("/", InstanceRoutes(runtime.upgradeWebSocket)),
      runtime,
    }
  }

  export async function openapi() {
    // Build a fresh app with all routes registered directly so
    // hono-openapi can see describeRoute metadata (`.route()` wraps
    // handlers when the sub-app has a custom errorHandler, which
    // strips the metadata symbol).
    const { app } = create({})
    const result = await generateSpecs(app, {
      documentation: {
        info: {
          title: "axiomsec",
          version: "0.1.0",
          description: "axiomsec api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  export let url: URL

  export async function listen(opts: {
    port: number
    hostname: string
    cors?: string[]
  }): Promise<Listener> {
    const built = create(opts)
    const server = await built.runtime.listen(opts)

    const next = new URL("http://localhost")
    next.hostname = opts.hostname
    next.port = String(server.port)
    url = next

    let closing: Promise<void> | undefined
    return {
      hostname: opts.hostname,
      port: server.port,
      url: next,
      stop(close?: boolean) {
        closing ??= (async () => {
          await server.stop(close)
        })()
        return closing
      },
    }
  }
}
