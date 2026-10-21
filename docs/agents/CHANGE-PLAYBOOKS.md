# AxiomSec Change Playbooks

Read when: implementing a change.
Every recipe ends with the same proof gate.

## 0. Universal preflight and postflight

**Preflight:** read the relevant invariant(s) in [INVARIANTS.md](INVARIANTS.md); find an analogous implementation; decide whether the change touches scope, permissions, proof, secrets, persistence, or generated files; if so, expect a `KNOWN-RISKS.md` update.

**Postflight:** `bun typecheck`, `bun run lint`, the single-platform build, the relevant `V-S*` scenario from [VERIFICATION.md](VERIFICATION.md), docs update, risk-register update. Never claim tests pass.

Read [ARCHITECTURE.md](ARCHITECTURE.md) §4 before changing tool behavior: the wrapper, not the tool, owns operation resolution, ledger events, workflow progress, context refresh, and truncation.

## A. Add a built-in tool

**Read first:** `SEC-02`, `SEC-03`, `ENG-03`, `ENG-04`; `packages/axiomsec/src/tools/tool.ts:205-450`; an analogous tool.

**Files to touch, in order:**

1. `packages/axiomsec/src/tools/<id>.ts` — `Tool.define("<id>", Effect.gen(...))`; import the description from `<id>.txt`; define Zod params; call `Guard.check*` for target-touching tools; call `ctx.ask` for sensitive actions; use `AbortSignal.any([ctx.abort, AbortSignal.timeout(...)])` for network/subprocess; declare `side_effects` in metadata; return `{ title, metadata, output }`.
2. `packages/axiomsec/src/tools/<id>.txt` — the model-facing description. Keep it precise about scope, side effects, and when not to use it.
3. `packages/axiomsec/src/tools/registry.ts` — import the tool, add `Tool.init(<XTool>)` to the `Effect.all` block, and add it to the `builtin` array. Registry keys are not tool ids: `fetch`→`webfetch`, `todo`→`todowrite`, `search`→`websearch`, `code`→`codesearch`, `patch`→`apply_patch`, `httprequest`→`http_request`.
4. `packages/axiomsec/src/permissions/permission.ts` — add the permission to `TOOL_WIDE_ALWAYS` only if “always” should apply to the whole tool. Otherwise leave it pattern-scoped.
5. `packages/axiomsec/src/agent/agent.ts` — add to `toolset_exclude` for lane-specific agents. This is a visibility gate, **replacement not merge**, and fail-open on typos.
6. `README.md` / `CHANGELOG.md` only if the tool is user-facing.

**Models:** `packages/axiomsec/src/tools/http-request.ts` for Guard + ask + timeout; `packages/axiomsec/src/tools/doctor.ts` for read-only; `packages/axiomsec/src/tools/evidence.ts`/`report.ts` for operation-scoped writes and `side_effects`. Note that `http_request` itself does not declare `side_effects` — do not copy that omission.

**Verify:** `bun typecheck`, `bun run lint`, build; `V-S3`; invalid arguments; a Guard-denied request; a timeout; output truncation; `debug agent` on a disposable loopback workspace.

**Pitfalls:** `ctx.ask` only prompts if the resolved ruleset says `ask`; built-in defaults are allow-all. The wrapper logs the full tool input — do not put secrets in args without a redaction plan. Do not write ledger/fact rows manually if the wrapper already does it; add domain facts through `Cyber` only when the tool has domain meaning. Do not call `Effect.orDie` for expected user/validation errors.

## B. Add an agent

**Read first:** `SEC-03`; `packages/axiomsec/src/agent/agent.ts:131-371`; `packages/axiomsec/src/agent/prompt/` examples; `packages/axiomsec/src/agent/switching.ts`.

**Files to touch:**

1. `packages/axiomsec/src/agent/prompt/<name>.txt` — the system prompt.
2. `packages/axiomsec/src/agent/agent.ts` — add an entry: `name`, `description`, `mode` (`primary`/`subagent`), `native`, `prompt`, `options`, `permission: Permission.merge(defaults, Permission.fromConfig({...}), user)`, `toolset_exclude`.
3. `packages/axiomsec/src/agent/switching.ts` only if selectable/switchable behavior is special.
4. `README.md`/`CHANGELOG.md` if user-facing.

Project-level agents can be added without code via `.axiomsec/agent/*.md` or config; keep the frontmatter/prompt format consistent with existing examples.

**Verify:** `axiomsec agent list`; `debug agent <name>`; the TUI switcher; the task/subagent tool list; deny/ask behavior with a disposable workspace. `V-S3`.

**Pitfalls:** defaults are allow-all; `toolset_exclude` replaces rather than merges and fails open; hidden agents are not switchable; `default_agent` must be primary and visible; a new agent does not automatically get the cyber tools excluded — add the lane rules deliberately.

## C. Add a slash command

**Read first:** `packages/axiomsec/src/commands/command.ts:69-80` and the command entries at `:96-201`; `packages/axiomsec/src/commands/template/` examples.

**Files to touch:**

1. `packages/axiomsec/src/commands/template/<name>.txt` — the prompt template. Use `$1`/`$ARGUMENTS`; `hints()` derives placeholders.
2. `packages/axiomsec/src/commands/command.ts` — import the template, add the name to `Default`, add a `commands[name]` entry with `description`, `source: "command"`, `priority`, a lazy `template` getter, `hints`, and optional `agent`/`model`/`subtask`.
3. `README.md`/`CHANGELOG.md` if user-facing.

**Verify:** list commands through the SDK/TUI; argument substitution; the `command.executed` event; `V-S1`. If the command changes agent/model, verify it in the TUI or via the server route.

**Pitfalls:** the real built-in name is `init`, not `initialize`; `/init` writes `AGENTS.md` and can overwrite the harness. Custom commands override built-ins; MCP/skill commands only fill unused names. Do not add a command that silently broadens permissions.

## D. Add a play/runbook

**Read first:** `packages/axiomsec/src/core/play/play.ts`; `packages/axiomsec/src/core/play/data/*` examples; `packages/axiomsec/src/core/doctor/catalog.ts` `PLAY_CAPABILITIES`; `packages/axiomsec/src/tools/runbook.ts`.

**Files to touch:**

1. `packages/axiomsec/src/core/play/data/<id>.ts` — a `Play` with `id`, `name`, `description`, `args`, and `steps` (tool/skill steps, conditionals, `requires`, `{{arg}}` substitution).
2. `packages/axiomsec/src/core/play/registry.ts` — import and register it.
3. `packages/axiomsec/src/core/doctor/catalog.ts` — add requirements to `PLAY_CAPABILITIES` so readiness is honest.
4. `packages/axiomsec/src/tools/runbook.ts` — add a `recommendedPlayIDs` mapping if the play is kind-specific.
5. Optional template/docs update.

**Verify:** `runbook` list/status/run; `play`; `/runbook`; doctor readiness; workflow JSON under `.axiomsec/operation/<slug>/workflow/`. `V-S2`, `V-S3`.

**Pitfalls:** referenced tool ids must exist; underlying tools still own Guard/ask/timeout; `runbook` persists workflow progress while `play` is excluded (`packages/axiomsec/src/tools/tool.ts:211`); do not interpolate shell strings into step args; a missing capability should degrade/skip, not silently fail.

## E. Add a DB migration

**Read first:** `ENG-05`; `packages/axiomsec/src/storage/db.ts:96-112`; `packages/axiomsec/script/build.ts:16-48`; `migration/` examples.

**Files to touch:**

1. Update the Drizzle schema (`packages/axiomsec/src/**/*.sql.ts`).
2. Generate `packages/axiomsec/migration/<timestamp>_<name>/migration.sql` with `bun run --cwd packages/axiomsec db generate`.
3. Review the generated SQL and journal. Do not hand-edit an applied migration; add a new one.

Schema migrations apply lazily when the DB opens (`packages/axiomsec/src/storage/db.ts:96-112`) and are embedded at build (`packages/axiomsec/script/build.ts:16-48`). `axiomsec db migrate` is the legacy JSON→SQLite data migration, **not** schema migration. `AXIOMSEC_SKIP_MIGRATIONS` replaces SQL with `select 1`; never use it on a real DB.

**Verify:** fresh `AXIOMSEC_DB` in a temp dir; open the CLI or `db path`; query the new table; `bun typecheck`; build. `V-S2`, `V-S8`.

**Pitfalls:** `packages/axiomsec/drizzle.config.ts:8` hardcodes `/tmp/axiomsec-dev.db` (Windows); timestamp ordering matters; there is no rollback; destructive changes need a new migration and a risk entry; do not edit generated snapshots by hand.

## F. Add a server route + SDK regeneration

**Read first:** `ENG-04`; `packages/axiomsec/src/server/instance/index.ts:34-105`; an existing route group; `packages/axiomsec/src/server/server.ts:40-57`.

**Files to touch:**

1. `packages/axiomsec/src/server/instance/<group>.ts` or `packages/axiomsec/src/server/instance/httpapi/<group>.ts` — Hono route with `describeRoute` (summary, unique `operationId`, responses), `validator("param"|"query"|"json", schema)`, and a `resolver` for the response schema.
2. `packages/axiomsec/src/server/instance/index.ts` — register the route group.
3. `packages/sdk/src/v2/gen/*` — regenerate, never hand-edit.
4. `packages/sdk/src/v2/client.ts` / `index.ts` only for wrapper behavior or exports.

`Server.openapi()` builds a fresh app so `describeRoute` metadata is not stripped by `.route()` (`packages/axiomsec/src/server/server.ts:40-57`). `axiomsec generate` prints the OpenAPI spec. **There is no checked-in SDK generator config** (`packages/sdk/package.json` has no generate script); recover/establish the `@hey-api/openapi-ts` invocation and record the gap, or stop and document the blocker. Do not invent generated code.

**Verify:** `serve` + `curl` with and without `AXIOMSEC_SERVER_PASSWORD`; SDK call compiles and hits the route; error paths; `bun typecheck`. `V-S5`.

**Pitfalls:** operationId collisions; metadata stripping; the SDK rewrites directory/workspace headers and disables the default fetch timeout; there are no operation/scope/finding HTTP endpoints at baseline; CORS/auth defaults.

## G. Fix a bug

1. Choose the invariant (`SEC-*`/`ENG-*`) and the risk ID; write the expected behavior in one sentence.
2. Reproduce with a `V-S*` scenario on a disposable workspace; capture logs, SQLite, and files.
3. Isolate the layer with [DEBUGGING.md](DEBUGGING.md); read the tool wrapper before changing a tool.
4. Make the smallest fix that restores the invariant. If the path is missing Guard/ask/timeout/InstanceState, add it.
5. Prove the original reproduction and a negative case; run the gate.
6. Update [KNOWN-RISKS.md](KNOWN-RISKS.md) (status/date/commit) and any affected deep doc.
7. Do not add tests or claim tests passed.

**Pitfalls:** swallowing errors to make the symptom disappear; widening scope/permissions; data loss during operation/migration changes; editing generated files; Windows-only paths; adding a module-global cache.

## H. Cross-cutting rules

- No module-global per-project state; use `Instance`/`InstanceState`.
- No `/tmp`; use `os.tmpdir()` and unique suffixes.
- No hand-edited generated files or applied migrations.
- No test files in ordinary PRs; propose a test harness as a separate repo-structure change.
- No direct markdown/JSONL canonical state; use the kernel services.
- No bypass of `Guard` or `ctx.ask`; no new network/subprocess without timeout/abort.
- Consider secret exposure in tool args, ledger events, evidence, shares, reports, and logs.
- Update `AGENTS.md` only when a cross-cutting rule changes; keep it ≤150 lines.

Next: [VERIFICATION.md](VERIFICATION.md) for proof, [INVARIANTS.md](INVARIANTS.md) for the rules, [ARCHITECTURE.md](ARCHITECTURE.md) for the map.
