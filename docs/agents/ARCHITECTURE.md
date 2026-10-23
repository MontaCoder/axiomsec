# AxiomSec Architecture

Read when: changing runtime behavior, adding a surface, or tracing a failure across layers.
Skip if: you only need a verification command.

Last verified: 2026-10-21 against commit `d1a6a18`. Re-read cited lines before relying on them.

## 1. Vocabulary

| Term | Meaning | Canonical code |
|---|---|---|
| Operation | A scoped engagement: target, boundary, opsec, facts, evidence, findings, deliverables | `packages/axiomsec/src/core/operation/operation.ts` |
| Kind | `pentest`, `appsec`, `osint`, `hacking`, `bughunt`, `ctf`, `research` | `packages/axiomsec/src/core/operation/operation.ts:39-65` |
| Boundary / scope | Allow/deny/ask rules plus `in_scope` / `out_of_scope` patterns | `packages/axiomsec/src/core/boundary/schema.ts`, `packages/axiomsec/src/core/boundary/evaluate.ts` |
| Opsec | `normal` or `strict`; strict blocks third-party intel hosts and upgrades unmatched asks to deny | `packages/axiomsec/src/core/boundary/guard.ts:19-26`, `:103-117` |
| Cyber kernel | Canonical SQLite state: ledger events, facts, relations, plus derived projections | `packages/axiomsec/src/core/cyber/cyber.ts`, `packages/axiomsec/src/core/cyber/cyber.sql.ts` |
| Ledger | Append-only audit events (`tool.called`, `tool.completed`, `tool.error`, workflow/fact events) | `packages/axiomsec/src/core/cyber/cyber.ts` |
| Fact / relation | Upserted typed knowledge and graph edges with writer, status, confidence, evidence refs | `packages/axiomsec/src/core/cyber/cyber.ts` |
| Evidence | SHA-256 content-addressed artifact plus `manifest.jsonl` | `packages/axiomsec/src/core/evidence/store.ts` |
| Replay | `.axiomsec/1` file: header, events, trailer with body SHA-256 and optional signature | `packages/axiomsec/src/core/replay/format.ts:7-42` |
| Finding | Candidate or finding record with status `observed`/`verified`/`rejected`/`stale` | `packages/axiomsec/src/core/cyber/finding.ts` |
| Oracle | Proof verdict: evidence present AND (replay present OR valid structured exemption) | `packages/axiomsec/src/core/cyber/oracle.ts:66-133` |
| Play / runbook | Declarative security workflow; `runbook` is the workflow surface, `play` the low-level trace | `packages/axiomsec/src/core/play/`, `packages/axiomsec/src/tools/runbook.ts` |
| Context pack / snapshot | Derived prompt-facing and UI-facing projection of operation state | `packages/axiomsec/src/core/operation/snapshot.ts` |
| Session / tool / agent / command / skill / plugin | Runtime conversation, tool contract, posture, slash command, instruction capsule, extension | `packages/axiomsec/src/session/`, `packages/axiomsec/src/tools/`, `packages/axiomsec/src/agent/`, `packages/axiomsec/src/commands/`, `packages/axiomsec/src/skills/`, `packages/axiomsec/src/plugins/` |

## 2. Runtime topology

```text
TUI thread ──RPC──> worker ──embedded Hono app.fetch──> session / tools / cyber kernel
   │                    │
   └── attach (HTTP) ───┘
serve ──Hono/SSE──> SDK / curl
acp ──stdio──> ACP agent
```

- The default CLI command starts the TUI; the TUI thread spawns a worker, and the worker serves the Hono app **in-process** through RPC `fetch` (`packages/axiomsec/src/cli/cmd/tui/worker.ts:45-63`), not a localhost port.
- TUI RPC calls are queued until the worker posts `rpc.ready`; the client pings until it receives one, so calls issued while the worker is still evaluating its module are not dropped (`packages/axiomsec/src/support/rpc.ts`). Worker requests dispatch concurrently and failures reject the pending call.
- Headless `serve` uses `Server.listen` (`packages/axiomsec/src/server/server.ts:61`) with loopback and a random port by default (`packages/axiomsec/src/cli/network.ts:5-15`). `attach` talks HTTP to a running server.
- The typed SDK is `packages/sdk/src/v2/client.ts`; generated client code is `packages/sdk/src/v2/gen/*` and must not be hand-edited.
- ACP lives in `packages/axiomsec/src/acp/agent.ts` and `packages/axiomsec/src/cli/cmd/acp.ts`; MCP management and OAuth live in `packages/axiomsec/src/mcp/`.
- Plugin hooks are defined in `packages/plugin/src/index.ts`; server-side loading/execution is `packages/axiomsec/src/plugins/`.

All surfaces converge on the session loop, tool registry, and cyber kernel. There is no separate “scanner service” or “report service” process.

## 3. Boot and instruction loading

- CLI entry: `packages/axiomsec/src/index.ts` answers `--version` before loading the graph, then dynamically imports `packages/axiomsec/src/main.ts` (yargs). Commands that need project state call `bootstrap` (`packages/axiomsec/src/cli/bootstrap.ts:5-18`), which wraps work in `Instance.provide` and `InstanceBootstrap`.
- `main.ts` resolves the invoked command with a metadata-only yargs probe (`packages/axiomsec/src/cli/commands.ts`) and imports only that command's module. Global help renders from the same metadata plus the shared TUI options (`packages/axiomsec/src/cli/cmd/tui/options.ts`); completion still loads the full registry for nested suggestions.
- `Instance` caches one context per canonical directory and restores it with AsyncLocalStorage (`packages/axiomsec/src/project/instance.ts:57-75`). `InstanceBootstrap` initializes plugins, then formatter, file, watcher, VCS, and snapshot services (`packages/axiomsec/src/project/bootstrap.ts:14-34`).
- Services are wired through one Effect layer and shared runtime in `packages/axiomsec/src/effect/app-runtime.ts`; per-project service state uses `InstanceState` (`packages/axiomsec/src/effect/instance-state.ts`).
- Instruction files (`packages/axiomsec/src/session/instruction.ts`):
  - Project candidates are `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`; **the first project-level match wins** (`:20-26`, `:129-137`).
  - `axiomsec.md` / `.axiomsec.md` are always loaded alongside (`:139-148`).
  - Global `AGENTS.md` / `~/.claude/CLAUDE.md` and config `instructions` are added (`:152-174`).
  - The active operation’s context pack is injected first (`:185-205`).
- Therefore: keep root `AGENTS.md` small; do **not** name a deep doc `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md`, or it will be auto-attached to every session. `docs/agents/*.md` is intentionally on-demand.

## 4. Session loop

1. `SessionPrompt.prompt` (`packages/axiomsec/src/session/prompt.ts:1256`) loads the session, cleans up reverts, creates the user message via `createUserMessage` (`:910`), persists tool toggles, and enters `runLoop` (`:1400`).
2. The loop handles pending compaction/subtasks, resolves the agent/model/variant, creates the assistant message, resolves tools (`:338`), injects skills/environment/instructions/operation context, and calls the processor.
3. `LLM.stream` (`packages/axiomsec/src/session/llm.ts:23`) wraps `streamText` (`:249`), assembles the system prompt, merges provider/agent/variant options, and filters the model-visible tools.
4. `SessionProcessor.process` (`packages/axiomsec/src/session/processor.ts:634`) drains the stream. `handleEvent` (`:252`) turns events into text/reasoning/tool/step parts, detects doom loops, updates usage/snapshots, applies plugin text transforms, and retries through `SessionRetry` (`:669`); cleanup always runs (`:682`).
5. Tool execution: `ToolRegistry` assembles built-ins, custom file tools, and plugin tools (`packages/axiomsec/src/tools/registry.ts:236-336`); the model sees a filtered subset. A `deny` rule removes the tool from that subset (`Permission.disabled`). Every tool call passes through `Tool.wrap` (`packages/axiomsec/src/tools/tool.ts:205-465`), which resolves the operation, validates and **applies** the parsed args (including Zod defaults/coercions), appends ledger events, updates workflow progress, refreshes the context pack, and truncates output. Plugin and config-file tools are wrapped through `Tool.wrapDef` so they get the same treatment; MCP tools are ledgered in `session/prompt.ts`.
6. Plugin hooks wrap execution before/after (`packages/axiomsec/src/session/prompt.ts:399-418`).

**Contract:** the tool implements validate → guard → ask → execute. The wrapper owns audit, workflow, context refresh, and truncation. A tool that bypasses the wrapper loses those behaviors.

## 5. Cyber kernel and canonical state

Canonical state is SQLite, not markdown (`packages/axiomsec/src/core/operation/operation.ts:1-14`):

- `cyber_ledger`, `cyber_fact`, `cyber_relation` tables (`packages/axiomsec/src/core/cyber/cyber.sql.ts:5-99`).
- Mirrored projections under `.axiomsec/operation/<slug>/cyber/{ledger,facts,relations}.jsonl`.
- Markdown notebook (`axiomsec.md`) is optional/derived; context packs, reports, and share bundles are projections.

Operation directory layout:

```text
.axiomsec/operation/<slug>/
  axiomsec.md                 optional legacy notebook
  cyber/{ledger,facts,relations}.jsonl
  workflow/
  context/active-context.md   derived
  evidence/<sha>.<ext> + manifest.jsonl
  deliverable/bundle-<stamp>/ report.md, report.json, manifest.json, manifest.sha256
  share-<stamp>.tar.gz
.axiomsec/operation/active    marker file containing the active slug
```

A slug is always a single directory name under `.axiomsec/operation/`; `packages/axiomsec/src/core/operation/slug.ts` validates it and asserts containment for every path primitive.

Operation resolution precedence: explicit slug → session binding → session attachment → workspace default → none (`packages/axiomsec/src/core/operation/resolver.ts:42-61`). Creation infers scope from the target hostname (`packages/axiomsec/src/core/operation/operation.ts:104-111`); a targetless operation starts with an empty scope.

Kernel writes: `Cyber.appendLedger` (`packages/axiomsec/src/core/cyber/cyber.ts:1193`), `upsertFact` (`:1245`), `syncWorkflowProgress` (`:1004`). Projection JSONL appends happen at `packages/axiomsec/src/core/cyber/cyber.ts:489`, after DB writes; projection failures are allowed to fail silently in several paths.

Operation creation writes initial facts/ledger/relations with whole-file writes (`packages/axiomsec/src/core/operation/operation.ts:355-362`). Slug uniqueness uses minute precision (`packages/axiomsec/src/core/operation/operation.ts:182-187`), so same-label operations created within one minute can collide.

## 6. Evidence, replay, findings, reports

- **Evidence**: `<sha256>.<ext>` plus append-only `manifest.jsonl` (`packages/axiomsec/src/core/evidence/store.ts:17`, `:55-103`). `get` returns the manifest entry and bytes but does not re-hash them.
- **Replay**: `axiomsec/1` header/event/trailer; trailer carries `sha256_body` and an optional signature (`packages/axiomsec/src/core/replay/format.ts:7-42`). CLI `verify` checks the body hash only; signature verification is not implemented (`packages/axiomsec/src/cli/cmd/replay.ts:93-113`).
- **Findings**: promotion requires independent evidence — a ref that resolves and re-hashes through `Evidence.verify` — plus replay or a structured, domain-valid exemption (`packages/axiomsec/src/core/cyber/oracle.ts:66-133`). The replay artifact is tracked separately and never counts as evidence. Reportability is defined at `packages/axiomsec/src/core/cyber/finding.ts:189-194`; rejected/stale claims remain visible and candidates are bucketed separately from suspected findings.
- **Reports**: deliverable bundles contain `report.md`, `report.json`, `manifest.json`, and `manifest.sha256` (`packages/axiomsec/src/core/deliverable/build.ts:422-596`).
- **Share**: copies evidence/cyber/workflow/context, writes a per-file manifest, redacts structured JSON/JSONL and text extensions (JWT, auth/cookie headers, secret keys), optionally signs, and tars the staging directory (`packages/axiomsec/src/tools/share.ts:118-243`).
- **Important gap:** finding promotion accepts arbitrary evidence-ref strings; it does not verify that the hash exists or that the bytes match (`packages/axiomsec/src/tools/finding.ts:245-309`). See `KNOWN-RISKS.md` `RISK-PROOF-01`.

## 7. Surfaces

- **Tools**: 47 built-ins assembled in `packages/axiomsec/src/tools/registry.ts:236-336`; each has a model-facing `.txt` description. `question` is conditional; `plan` is experimental/conditional.
- **Agents**: `security`, `pentest`, `appsec`, `osint`, `hacking`, plus `plan`, `general`, `explore`, and hidden `compaction`/`title`/`summary` (`packages/axiomsec/src/agent/agent.ts:131-371`). Default is `security`.
- **Commands**: 10 built-ins (`packages/axiomsec/src/commands/command.ts:69-80`). The real name is `init`, not `initialize`; `/init` generates/updates `AGENTS.md` (`packages/axiomsec/src/commands/command.ts:181-190`).
- **Plays**: 12 built-ins (`packages/axiomsec/src/core/play/registry.ts:15-28`). `runbook` persists workflow progress; `play` is excluded from workflow progress (`packages/axiomsec/src/tools/tool.ts:211`).
- **Skills/plugins**: built-in skills under `packages/axiomsec/skills/`; discovery in `packages/axiomsec/src/skills/`; plugin API in `packages/plugin/`.

## 8. Boundaries and permissions

- Permission rules are last-match wildcard rules (`packages/axiomsec/src/permissions/evaluate.ts:9-15`); when nothing matches, the action is `ask`. Resolution order is live ruleset first, then a stored “always” approval; an explicit `deny` always wins and removes the tool from the registry.
- Built-in agents start from `"*": "allow"` and add explicit asks for network, shell, secret, MCP and operation-record tools (`packages/axiomsec/src/agent/agent.ts:110-140`, `:143-144`, `:166-167`, `:189-190`, `:213-214`, `:248-249`). User config merges last.
- `ctx.ask` is plumbed from the session loop (`packages/axiomsec/src/session/prompt.ts:374`); approvals can be “once” or “always” and are persisted per project.
- Guard (`packages/axiomsec/src/core/boundary/guard.ts:87-118`):
  - No active operation → `allow` (`:89`).
  - Strict opsec blocks third-party intel hosts (`:19-26`).
  - Explicit deny throws `ScopeDeniedError` (`:103-117`).
  - `ask` is **returned**, not thrown; the caller decides what to do next.
- Scheme-qualified boundary patterns compare protocol, hostname (wildcards allowed), effective port, and then a path prefix/glob (`packages/axiomsec/src/core/boundary/evaluate.ts:13-46`); raw URL prefix matching is not used.
- Guard coverage today: `http_request`, `webfetch`, `scanner`, `appsec_probe`, `browser`, and `net` call it. HTTP(S) redirects are re-checked hop-by-hop by `packages/axiomsec/src/tools/guarded-http.ts`; scanner crawl/JS subresources go through an `allowUrl` callback (`packages/axiomsec/src/scanners/http.ts`); browser WebSocket handshakes are checked by `context.routeWebSocket` (`packages/axiomsec/src/tools/browser.ts:256-269`). `bash` remains unguarded (`RISK-SCOPE-03`). The boundary check is a per-tool convention, not a runtime choke point.
- `debug agent` executes a tool without an LLM call; ask-level tools require `--dangerously-skip-permissions` and print each bypass (`packages/axiomsec/src/cli/cmd/debug/agent.ts:35-38,190-200`). `run --dangerously-skip-permissions` auto-approves every ask (`packages/axiomsec/src/cli/cmd/run.ts:544-548`).

## 9. Server, API, SDK, ACP

- Hono middleware order: error → auth → logger → compression → CORS → instance routes (`packages/axiomsec/src/server/server.ts:24-37`). Auth is optional: if `AXIOMSEC_SERVER_PASSWORD` is unset, requests pass (`packages/axiomsec/src/server/middleware.ts:39-49`). CORS allows localhost, Tauri, `*.axiomsec.ai`, and configured origins (`:68-82`).
- Route groups: project, pty, config, experimental, session, permission, question, provider, sync, files, events, mcp, tui (`packages/axiomsec/src/server/instance/index.ts:34-105`). There are **no HTTP operation/scope/finding endpoints** at baseline; use CLI, tools, or SQLite for those.
- OpenAPI: `Server.openapi()` builds a fresh app so `describeRoute` metadata survives (`packages/axiomsec/src/server/server.ts:40-57`). `axiomsec generate` prints the spec.
- SDK: `packages/sdk/src/v2/client.ts`; generated code under `packages/sdk/src/v2/gen/*`. There is no checked-in generator script; do not invent or hand-edit generated code.
- ACP: `packages/axiomsec/src/cli/cmd/acp.ts` plus `packages/axiomsec/src/acp/agent.ts`. MCP OAuth callback currently listens on all interfaces (`packages/axiomsec/src/mcp/oauth-callback.ts:187`).

## 10. Paths, config, logs

- Global paths are XDG-derived (`packages/axiomsec/src/globals/global.ts:10-26`). `axiomsec debug paths` is authoritative; do not guess.
- Config is layered: global files → `AXIOMSEC_CONFIG` → project `axiomsec.json[c]` → discovered `.axiomsec` dirs → `AXIOMSEC_CONFIG_CONTENT` → managed config. Later merges win; `instructions` arrays concatenate. The schema is strict; unknown keys fail.
- `{env:VAR}` and `{file:path}` substitutions are supported.
- Logs: `packages/axiomsec/src/support/log.ts:60-94`. `--print-logs` writes to stderr and does not create a file; local dev writes `dev.log`; file logs are timestamped and keep 10.
- Key env: `AXIOMSEC_DB`, `AXIOMSEC_CONFIG_CONTENT`, `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`, `AXIOMSEC_TEST_HOME` (only changes `Global.Path.home`), `AXIOMSEC_DISABLE_MODELS_FETCH`, `AXIOMSEC_DISABLE_AUTOUPDATE`, `AXIOMSEC_SERVER_PASSWORD`.

## 11. Change map

| If you change | Read first | Inspect | Verify |
|---|---|---|---|
| A tool | `INVARIANTS.md` `SEC-03`, `ENG-04` | `packages/axiomsec/src/tools/tool.ts:205-450`, `packages/axiomsec/src/tools/registry.ts`, analogous tool | `V-S3` |
| An agent | `INVARIANTS.md` `SEC-03` | `packages/axiomsec/src/agent/agent.ts`, `packages/axiomsec/src/agent/prompt/*` | `V-S3` |
| A slash command | `ARCHITECTURE.md` §7 | `packages/axiomsec/src/commands/command.ts`, `packages/axiomsec/src/commands/template/*` | `V-S1`, `V-S3` |
| A play/runbook | `ARCHITECTURE.md` §7 | `packages/axiomsec/src/core/play/`, `packages/axiomsec/src/core/doctor/catalog.ts` | `V-S2`, `V-S3` |
| A DB migration | `ENG-05` | `packages/axiomsec/src/storage/db.ts`, `packages/axiomsec/script/build.ts`, `packages/axiomsec/migration/` | `V-S2`, `V-S8` |
| A server route | `ENG-04` | `packages/axiomsec/src/server/instance/index.ts`, SDK `gen/*` | `V-S5` |
| Scope/permissions | `SEC-01`, `SEC-02`, `SEC-03` | `packages/axiomsec/src/core/boundary/guard.ts`, `packages/axiomsec/src/permissions/`, `packages/axiomsec/src/agent/agent.ts` | `V-S3` |
| Findings/evidence | `SEC-04`, `SEC-05` | `packages/axiomsec/src/core/cyber/`, `packages/axiomsec/src/core/evidence/` | `V-S4` |
| Server/MCP exposure | `SEC-07` | `packages/axiomsec/src/server/middleware.ts`, `packages/axiomsec/src/mcp/oauth-callback.ts` | `V-S5` |
| Build/release | `ENG-05`, `ENG-06` | `packages/axiomsec/script/build.ts`, `.github/workflows/` | `V-S8` |

Next: [INVARIANTS.md](INVARIANTS.md) for the rules, [DEBUGGING.md](DEBUGGING.md) for failures, [BUG-HUNTING.md](BUG-HUNTING.md) for audits, [CHANGE-PLAYBOOKS.md](CHANGE-PLAYBOOKS.md) for recipes, [VERIFICATION.md](VERIFICATION.md) for proof, [KNOWN-RISKS.md](KNOWN-RISKS.md) for current defects.
