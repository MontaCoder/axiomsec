import z from "zod"
import { Effect, Exit } from "effect"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permissions"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"
import { Cyber } from "@/core/cyber"
import { Operation } from "@/core/operation"
import * as OperationResolver from "@/core/operation/resolver"
import * as OperationSnapshot from "@/core/operation/snapshot"
import { redactValue } from "@/core/replay/redact"
import { Instance } from "@/project/instance"
import { Log } from "../support"

const log = Log.create({ service: "tool" })

interface Metadata {
  [key: string]: any
}

export const SIDE_EFFECT_CATEGORIES = [
  "read_only",
  "writes_ledger",
  "writes_facts",
  "writes_evidence",
  "network",
  "mutates_target",
  "mutates_workspace",
] as const

export type SideEffectCategory = (typeof SIDE_EFFECT_CATEGORIES)[number]

/**
 * Conservative contracts for tools whose result metadata does not carry a
 * per-action `side_effects` array. Per-call metadata always wins. The policy
 * suite requires every built-in tool id to appear here.
 */
export const DEFAULT_SIDE_EFFECTS: Record<string, readonly SideEffectCategory[]> = {
  analyze: ["network", "mutates_target", "writes_ledger", "writes_facts", "writes_evidence"],
  apply_patch: ["mutates_workspace"],
  appsec_probe: ["network", "mutates_target", "writes_ledger", "writes_facts", "writes_evidence"],
  autonomy: ["writes_ledger", "writes_facts"],
  bash: ["network", "mutates_target", "mutates_workspace", "writes_ledger"],
  binary_triage: ["network", "writes_ledger", "writes_facts", "writes_evidence"],
  browser: ["network", "mutates_target"],
  cloud_posture: ["network", "mutates_target", "writes_ledger", "writes_facts", "writes_evidence"],
  codesearch: ["network", "read_only"],
  container_surface: ["network", "mutates_target", "writes_ledger", "writes_facts", "writes_evidence"],
  crypto: ["read_only"],
  cve: ["network", "read_only"],
  doctor: ["writes_ledger", "writes_facts"],
  edit: ["mutates_workspace"],
  evidence: ["writes_ledger", "writes_evidence"],
  finding: ["writes_ledger", "writes_facts"],
  glob: ["read_only"],
  grep: ["read_only"],
  http_request: ["network"],
  iac_triage: ["network", "writes_ledger", "writes_facts", "writes_evidence"],
  identity: ["mutates_workspace", "writes_ledger"],
  interact: ["network", "mutates_target", "mutates_workspace"],
  invalid: ["read_only"],
  knowledge: ["network", "writes_ledger", "writes_facts", "writes_evidence"],
  methodology: ["read_only"],
  net: ["network", "mutates_target"],
  observation: ["writes_ledger", "writes_facts"],
  opsec: ["writes_ledger", "writes_facts"],
  plan_exit: ["read_only"],
  play: ["writes_ledger", "writes_facts", "mutates_workspace"],
  pwn_bootstrap: ["mutates_workspace", "writes_ledger", "writes_facts"],
  question: ["read_only"],
  read: ["read_only"],
  remediate: ["mutates_workspace", "writes_ledger", "writes_facts", "writes_evidence"],
  report: ["writes_ledger", "writes_facts", "mutates_workspace"],
  runbook: ["writes_ledger", "writes_facts", "mutates_workspace"],
  scanner: ["network", "mutates_target", "writes_ledger", "writes_facts", "writes_evidence"],
  scope: ["writes_ledger", "writes_facts"],
  share: ["writes_ledger", "writes_facts", "mutates_workspace"],
  skill: ["read_only"],
  task: ["network", "mutates_target", "mutates_workspace", "writes_ledger", "writes_facts", "writes_evidence"],
  todowrite: ["read_only"],
  vault: ["mutates_workspace", "writes_ledger"],
  webfetch: ["network"],
  websearch: ["network"],
  workspace: ["writes_ledger", "writes_facts", "mutates_workspace"],
  write: ["mutates_workspace"],
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  operation?: OperationResolver.OperationResolution
  extra?: { [key: string]: any }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  description: string
  parameters: Parameters
  execute(args: z.infer<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: z.ZodError): string
}
export type DefWithoutID<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> = Omit<
  Def<Parameters, M>,
  "id"
>

export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends z.ZodType, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any> ? z.infer<P> : T extends Effect.Effect<Info<infer P, any>, any, any> ? z.infer<P> : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

export function sideEffects(...categories: SideEffectCategory[]) {
  return categories
}

export function resolveOperationSlug(ctx: Context, workspace: string, explicitSlug?: string) {
  if (explicitSlug) {
    // A slug that could escape the operation tree is never resolved. Tools that
    // accept an explicit slug validate it up front and report the problem.
    if (!Operation.isValidSlug(explicitSlug)) return Effect.succeed(undefined)
    return Effect.succeed(explicitSlug)
  }
  if (ctx.operation?.slug) return Effect.succeed(ctx.operation.slug)
  return Effect.promise(() =>
    OperationResolver.resolveOperation({
      workspace,
      sessionID: ctx.sessionID,
      allowWorkspaceDefault: true,
    }).then((operation) => operation.slug),
  )
}

function normalizedSideEffects(metadata: Metadata) {
  const effects = Array.isArray(metadata.side_effects) ? metadata.side_effects.map(String) : []
  return effects
}

const SECRET_ARG_FIELDS: Record<string, readonly string[]> = {
  vault: ["value"],
  identity: ["value"],
}

export function redactToolInput(id: string, args: unknown): unknown {
  const redacted = redactValue(args, "on")
  const fields = SECRET_ARG_FIELDS[id]
  if (!fields || !redacted || typeof redacted !== "object" || Array.isArray(redacted)) return redacted
  const output: Record<string, unknown> = Object.fromEntries(Object.entries(redacted))
  for (const field of fields) {
    if (field in output) output[field] = `[redacted:secret:${field}]`
  }
  return output
}

function sideEffectContract<M extends Metadata>(
  metadata: M,
  input: {
    auditLogged: boolean
    contextWritten: boolean
    workflowProgressWritten: boolean
  },
) {
  const effects = normalizedSideEffects(metadata)
  const domainWrites = effects.filter((effect) => !["read_only", "network", "writes_ledger"].includes(effect))
  return {
    ...metadata,
    side_effects: effects,
    audit_logged: input.auditLogged,
    domain_writes: domainWrites,
    context_written: input.contextWritten,
    evidence_written: effects.includes("writes_evidence"),
    facts_written: effects.includes("writes_facts"),
    workflow_progress_written: input.workflowProgressWritten,
  } as M
}

function isReadOnlyResult(metadata: Metadata) {
  const effects = normalizedSideEffects(metadata)
  return (
    effects.includes("read_only") &&
    !effects.some((item) =>
      ["writes_facts", "writes_evidence", "mutates_target", "mutates_workspace"].includes(item),
    )
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.map(asRecord)
  if (!items.every((item): item is Record<string, unknown> => Boolean(item))) return undefined
  return items
}

function formatUnknownError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return "unknown error"
  }
}

function isOrientationToolCall(id: string, args: unknown) {
  const parsed = z.record(z.string(), z.unknown()).safeParse(args)
  const action = parsed.success && typeof parsed.data["action"] === "string" ? parsed.data["action"] : undefined
  if (id === "workspace") {
    return ["status", "list", "snapshot", "capabilities", "query", "graph_digest", "timeline"].includes(action ?? "status")
  }
  if (id === "report") return (action ?? "status") === "status"
  if (id === "share") return (action ?? "status") === "status"
  if (id === "evidence") return ["list", "search", "get"].includes(action ?? "list")
  if (id === "runbook") return (action ?? "list") === "list"
  return false
}

function explicitOperationSlug(args: unknown) {
  const parsed = z.record(z.string(), z.unknown()).safeParse(args)
  if (!parsed.success) return undefined
  const slug = parsed.data["slug"]
  // Only well-formed slugs may reach operation resolution. A malformed slug is
  // ignored here and rejected loudly by resolveOperationSlug when a tool asks
  // for it explicitly. (RISK-SCOPE-07)
  return typeof slug === "string" && Operation.isValidSlug(slug) ? slug : undefined
}

function refreshDerivedContext(workspace: string, slug?: string) {
  return Effect.gen(function* () {
    const active = yield* Effect.promise(() =>
      slug ? Operation.read(workspace, slug).catch(() => undefined) : Operation.active(workspace).catch(() => undefined),
    )
    if (!active) return false
    const snapshot = yield* Effect.promise(() =>
      OperationSnapshot.build(workspace, { slug: active.slug, operation: active, includeDoctor: false }).catch(
        () => undefined,
      ),
    )
    if (!snapshot) return false
    const derived = OperationSnapshot.renderContext(snapshot, { mode: "write_context" })
    return yield* Effect.promise(() => Operation.writeContextPack(workspace, active.slug, derived).then(() => true)).pipe(
      Effect.catch(() => Effect.succeed(false)),
    )
  })
}

function currentInstance() {
  try {
    return Instance.current
  } catch {
    return undefined
  }
}

function wrap<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  const workflowAware = id !== "play"
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          const instance = currentInstance()
          const operation: OperationResolver.OperationResolution = instance
            ? yield* Effect.promise(() =>
                OperationResolver.resolveOperation({
                  workspace: instance.directory,
                  sessionID: ctx.sessionID,
                  explicitSlug: explicitOperationSlug(args),
                }),
              ).pipe(Effect.catch(() => Effect.succeed({ source: "none" as const })))
            : { source: "none" as const }
          const toolCtx = { ...ctx, operation }
          // Audit the attempt before validating. Validation itself is part of
          // the call; a malformed model argument must not disappear from the
          // ledger, and it must be visible even when the tool never executes.
          // (ENG-04 / RISK-AUDIT-05)
          const callEvent = yield* Cyber.appendLedger({
              operation_slug: operation.slug,
              kind: "tool.called",
              source: id,
              session_id: ctx.sessionID,
              message_id: ctx.messageID,
              summary: `${id} called`,
              data: {
                tool: id,
                call_id: ctx.callID,
                input: redactToolInput(id, args),
              },
            })
            .pipe(Effect.catch(() => Effect.succeed("")))
          const parsed = yield* Effect.exit(
            Effect.try({
              try: () => toolInfo.parameters.parse(args),
              catch: (error) => {
                if (error instanceof z.ZodError && toolInfo.formatValidationError) {
                  return new Error(toolInfo.formatValidationError(error), { cause: error })
                }
                return new Error(
                  `The ${id} tool was called with invalid arguments: ${formatUnknownError(error)}.\nPlease rewrite the input so it satisfies the expected schema.`,
                  { cause: error },
                )
              },
            }),
          )
          if (Exit.isFailure(parsed)) {
            yield* Cyber.appendLedger({
              operation_slug: operation.slug,
              kind: "tool.error",
              source: id,
              session_id: ctx.sessionID,
              message_id: ctx.messageID,
              status: "error",
              summary: `${id} failed validation`,
              data: {
                tool: id,
                call_id: ctx.callID,
                source_event_id: callEvent,
                reason: "invalid arguments",
              },
            }).pipe(Effect.catch(() => Effect.void))
            return yield* Effect.failCause(parsed.cause)
          }
          const validatedArgs = parsed.value
          const exit = yield* Effect.exit(execute(validatedArgs, toolCtx))
          if (Exit.isFailure(exit)) {
            yield* Cyber.appendLedger({
                operation_slug: operation.slug,
                kind: "tool.error",
                source: id,
                session_id: ctx.sessionID,
                message_id: ctx.messageID,
                status: "error",
                summary: `${id} failed`,
                data: {
                  tool: id,
                  call_id: ctx.callID,
                  source_event_id: callEvent,
                },
              })
              .pipe(Effect.catch(() => Effect.void))
	            if (workflowAware && instance && !isOrientationToolCall(id, validatedArgs)) {
	              const workspace = instance.directory
	              const slug = operation.slug
              if (slug) {
                const match = yield* Effect.promise(() =>
                  Operation.recordWorkflowStep(workspace, slug, {
                    tool: id,
                    success: false,
                    error: "tool execution failed",
                    args: redactToolInput(id, validatedArgs),
                  }).catch(() => undefined),
                ).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (match) {
                  const workflow = yield* Effect.promise(() =>
                    Operation.readWorkflow(workspace, slug, {
                      kind: match.kind,
                      id: match.id,
                    }).catch(() => undefined),
                  ).pipe(Effect.catch(() => Effect.succeed(undefined)))
                  const workflowRecord = asRecord(workflow)
                  const trace = asRecordArray(workflowRecord?.trace)
                  const skipped = asRecordArray(workflowRecord?.skipped)
                  if (workflowRecord && trace && skipped) {
                    yield* Cyber.syncWorkflowProgress({
                      operation_slug: slug,
                      workflow_kind: match.kind,
                      workflow_id: match.id,
                      trace,
                      skipped,
                      completed_steps: Number(workflowRecord.completed_steps ?? 0),
                      failed_steps: Number(workflowRecord.failed_steps ?? 0),
                      pending_steps: Number(workflowRecord.pending_steps ?? 0),
                      session_id: ctx.sessionID,
                      message_id: ctx.messageID,
                      source: "workflow",
                      summary: `${match.kind} ${match.id} progress after ${id} failure`,
                    }).pipe(Effect.catch(() => Effect.succeed("")))
                  }
                  yield* Cyber.appendLedger({
                    operation_slug: slug,
                    kind: "fact.observed",
                    source: "workflow",
                    session_id: ctx.sessionID,
                    message_id: ctx.messageID,
                    summary: `${match.kind} ${match.id} step ${match.step_index} failed via ${id}`,
                    data: {
                      workflow_kind: match.kind,
                      workflow_id: match.id,
                      step_index: match.step_index,
                      status: match.status,
                      tool: id,
                    },
	                  }).pipe(Effect.catch(() => Effect.succeed("")))
	                }
	                if (id !== "report") {
	                  yield* refreshDerivedContext(workspace, slug).pipe(Effect.catch(() => Effect.void))
	                }
	              }
	            }
	            return yield* Effect.failCause(exit.cause)
          }
          const result = exit.value
          const metadataWithEffects =
            normalizedSideEffects(result.metadata).length > 0
              ? result.metadata
              : { ...result.metadata, side_effects: DEFAULT_SIDE_EFFECTS[id] ?? [] }
          const readOnlyResult = isReadOnlyResult(metadataWithEffects)
          const workflowProgressEligible = workflowAware && !isOrientationToolCall(id, validatedArgs)
          let workflowProgressWritten = false
          let contextWritten = false
          let completionLogged = false
          yield* Cyber.appendLedger({
              operation_slug: operation.slug,
              kind: "tool.completed",
              source: id,
              session_id: ctx.sessionID,
              message_id: ctx.messageID,
              status: "completed",
              summary: `${id} completed`,
              data: {
                tool: id,
                call_id: ctx.callID,
                source_event_id: callEvent,
                title: result.title,
                metadata: { ...metadataWithEffects, operation },
              },
            })
            .pipe(
              Effect.tap((eventID) =>
                Effect.sync(() => {
                  completionLogged = Boolean(callEvent) && Boolean(eventID)
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  log.warn("tool.completed ledger write failed", {
                    tool: id,
                    call_id: ctx.callID,
                    error: String(cause),
                  })
                }),
              ),
            )
	          if (workflowProgressEligible && instance) {
	            const workspace = instance.directory
	            const slug = operation.slug
            if (slug) {
              const match = yield* Effect.promise(() =>
                Operation.recordWorkflowStep(workspace, slug, {
                  tool: id,
                  success: true,
                  title: result.title,
                  args: redactToolInput(id, validatedArgs),
                }).catch(() => undefined),
              ).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (match) {
                const workflow = yield* Effect.promise(() =>
                  Operation.readWorkflow(workspace, slug, {
                    kind: match.kind,
                    id: match.id,
                  }).catch(() => undefined),
                ).pipe(Effect.catch(() => Effect.succeed(undefined)))
                const workflowRecord = asRecord(workflow)
                const trace = asRecordArray(workflowRecord?.trace)
                const skipped = asRecordArray(workflowRecord?.skipped)
                if (workflowRecord && trace && skipped) {
                  yield* Cyber.syncWorkflowProgress({
                    operation_slug: slug,
                    workflow_kind: match.kind,
                    workflow_id: match.id,
                    trace,
                    skipped,
                    completed_steps: Number(workflowRecord.completed_steps ?? 0),
                    failed_steps: Number(workflowRecord.failed_steps ?? 0),
                    pending_steps: Number(workflowRecord.pending_steps ?? 0),
                    session_id: ctx.sessionID,
                    message_id: ctx.messageID,
                    source: "workflow",
                    summary: `${match.kind} ${match.id} progress after ${id} completion`,
                  }).pipe(Effect.catch(() => Effect.succeed("")))
                }
                yield* Cyber.appendLedger({
                  operation_slug: slug,
                  kind: "fact.observed",
                  source: "workflow",
                  session_id: ctx.sessionID,
                  message_id: ctx.messageID,
                  summary: `${match.kind} ${match.id} step ${match.step_index} completed via ${id}`,
                  data: {
                    workflow_kind: match.kind,
                    workflow_id: match.id,
                    step_index: match.step_index,
                    status: match.status,
                    tool: id,
                  },
	                }).pipe(Effect.catch(() => Effect.succeed("")))
                  workflowProgressWritten = true
	              }
	              if (id !== "report" && (match || !readOnlyResult)) {
	                contextWritten = yield* refreshDerivedContext(workspace, slug).pipe(Effect.catch(() => Effect.succeed(false)))
	              }
	            }
	          }
          const finalResult = {
            ...result,
            metadata: sideEffectContract(metadataWithEffects, {
              auditLogged: completionLogged,
              contextWritten,
              workflowProgressWritten,
            }),
          }
          const finalMetadata = finalResult.metadata as Record<string, unknown>
          finalMetadata.operation_slug = operation.slug
          finalMetadata.operation_source = operation.source
          if (finalResult.metadata.truncated !== undefined) {
            return finalResult
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(finalResult.output, {}, agent)
          return {
            ...finalResult,
            output: truncated.content,
            metadata: {
              ...finalResult.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      return toolInfo
    })
}

export function define<Parameters extends z.ZodType, Result extends Metadata, R, ID extends string = string>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends z.ZodType, M extends Metadata>(info: Info<P, M>): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

/**
 * Wrap an externally supplied tool definition (a plugin or a config file tool)
 * in the same audit boundary the built-ins use.
 *
 * Without this a plugin tool would run with no ledger events, no argument
 * validation, no workflow progress and no context refresh. (ENG-04 / RISK-AUDIT-01)
 */
export function wrapDef<P extends z.ZodType, M extends Metadata>(
  id: string,
  def: DefWithoutID<P, M>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
): Effect.Effect<Info<P, M>> {
  return Object.assign(
    Effect.gen(function* () {
      return { id, init: wrap(id, def, truncate, agents) }
    }),
    { id },
  )
}
