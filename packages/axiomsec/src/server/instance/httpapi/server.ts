import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpApiBuilder, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http"
import { OtlpExporter } from "effect/observability"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Observability } from "@/effect"
import { memoMap } from "@/effect/run-service"
import { Flag } from "@/flags/flag"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Instance } from "@/project/instance"
import { lazy } from "@/support/lazy"
import { Filesystem } from "@/support"
import { PermissionApi, permissionHandlers } from "./permission"
import { ProviderApi, providerHandlers } from "./provider"
import { QuestionApi, questionHandlers } from "./question"

const Query = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
})

const Headers = Schema.Struct({
  authorization: Schema.optional(Schema.String),
  "x-axiomsec-directory": Schema.optional(Schema.String),
})

export namespace ExperimentalHttpApiServer {
  function decode(input: string) {
    try {
      return decodeURIComponent(input)
    } catch {
      return input
    }
  }

  class Unauthorized extends Schema.TaggedError<Unauthorized>()(
    "Unauthorized",
    { message: Schema.String },
    { httpApiStatus: 401 },
  ) {}

  class Authorization extends HttpApiMiddleware.Service<Authorization>()("@axiomsec/ExperimentalHttpApiAuthorization", {
    error: Unauthorized,
    security: {
      basic: HttpApiSecurity.basic,
    },
  }) {}

  const auth = Layer.succeed(
    Authorization,
    Authorization.of({
      basic: (effect, { credential }) =>
        Effect.gen(function* () {
          if (!Flag.AXIOMSEC_SERVER_PASSWORD) return yield* effect

          const user = Flag.AXIOMSEC_SERVER_USERNAME ?? "axiomsec"
          if (credential.username !== user) {
            return yield* new Unauthorized({ message: "Unauthorized" })
          }
          if (Redacted.value(credential.password) !== Flag.AXIOMSEC_SERVER_PASSWORD) {
            return yield* new Unauthorized({ message: "Unauthorized" })
          }
          return yield* effect
        }),
    }),
  )

  const instance = HttpRouter.middleware()(
    Effect.gen(function* () {
      return (effect) =>
        Effect.gen(function* () {
          const query = yield* HttpServerRequest.schemaSearchParams(Query)
          const headers = yield* HttpServerRequest.schemaHeaders(Headers)
          const raw = query.directory || headers["x-axiomsec-directory"] || process.cwd()
          const workspace = query.workspace || undefined
          const ctx = yield* Effect.promise(() =>
            Instance.provide({
              directory: Filesystem.resolve(decode(raw)),
              init: () => AppRuntime.runPromise(InstanceBootstrap),
              fn: () => Instance.current,
            }),
          )

          const next = workspace ? effect.pipe(Effect.provideService(WorkspaceRef, workspace)) : effect
          return yield* next.pipe(Effect.provideService(InstanceRef, ctx))
        })
    }),
  ).layer

  const QuestionSecured = QuestionApi.middleware(Authorization)
  const PermissionSecured = PermissionApi.middleware(Authorization)
  const ProviderSecured = ProviderApi.middleware(Authorization)

  export const routes = Layer.mergeAll(
    HttpApiBuilder.layer(QuestionSecured).pipe(Layer.provide(questionHandlers)),
    HttpApiBuilder.layer(PermissionSecured).pipe(Layer.provide(permissionHandlers)),
    HttpApiBuilder.layer(ProviderSecured).pipe(Layer.provide(providerHandlers)),
  ).pipe(
    Layer.provide(auth),
    Layer.provide(instance),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(Observability.layer),
    Layer.provide(OtlpExporter.layerFlusher),
  )

  export const webHandler = lazy(() =>
    HttpRouter.toWebHandler(routes, {
      memoMap,
    }),
  )
}
