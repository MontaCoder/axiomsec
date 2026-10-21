# AxiomSec Debugging Playbook

Read when: something fails and you need a layer, not a guess.

## 0. Rules

- **Read-only first.** Capture logs, SQLite rows, and files before mutating anything.
- **Reproduce on loopback or a disposable workspace.** Never debug against a third-party target or a real operation.
- **Capture three sources:** logs, SQLite, files/projections. Do not trust one source: the ledger can be incomplete, projections can lag, and logs can omit.
- **Smallest instrument first.** Logs and `debug` commands before adding code or a debugger.
- **Remove temporary instrumentation before the PR.** Do not add test files (the lite repo gitignores them).

This repo has no test suite. The verification scenarios live in [VERIFICATION.md](VERIFICATION.md); this file tells you how to find the layer when one fails.

## 1. Instruments

| Instrument | Command / path | Notes |
|---|---|---|
| stderr logs | `--print-logs --log-level DEBUG` | Global flags; `--print-logs` writes to stderr and **does not** create a file (`packages/axiomsec/src/support/log.ts:60-78`). |
| file logs | `axiomsec debug paths` → `log` | Local dev writes `dev.log`; timestamped logs keep the last 10 (`packages/axiomsec/src/support/log.ts:60-94`). |
| Resolved config | `axiomsec debug config` | Merged config JSON; do not paste secrets into an issue. |
| Global paths | `axiomsec debug paths` | Authoritative data/config/cache/state/log paths. |
| File layer | `axiomsec debug file <read / status / list / search / tree>` | Uses the app’s file service, not raw shell. |
| Ripgrep layer | `axiomsec debug rg <tree / files / search>` | Diagnoses the bundled search worker. |
| Skills | `axiomsec debug skill` | Lists discovered skills. |
| Snapshots | `axiomsec debug snapshot <track / patch / diff>` | Workspace snapshots, not operation state. |
| Agent/tool | `axiomsec debug agent <name> --tool <id> --params '<json>'` | Runs a tool without an LLM call. Requires a default model; **ask-level tools require `--dangerously-skip-permissions`, which prints each bypass** (`packages/axiomsec/src/cli/cmd/debug/agent.ts:35-38,190-200`). |
| Database | `axiomsec db path`, `axiomsec db query "..." --format json` | Query opens SQLite read-only (`packages/axiomsec/src/cli/cmd/db.ts:28-48`). |
| Operations | `axiomsec operation list --format json`, `axiomsec operation show [slug] --format <summary / json / context / markdown>` | `show` defaults to the active operation. |
| Sessions | `axiomsec session list --format json` | Session IDs for replay and DB inspection. |
| Replay | `axiomsec replay show <file>`, `axiomsec replay verify <file>` | Verify checks body SHA-256 only; signatures are not verified (`packages/axiomsec/src/cli/cmd/replay.ts:93-113`). |
| TUI timing | `AXIOMSEC_SHOW_TTFD=1` | Prints time-to-first-draw. |
| Heap | `AXIOMSEC_AUTO_HEAP_SNAPSHOT=1` | Writes a V8 heap snapshot under the log dir when RSS exceeds 2 GiB (`packages/axiomsec/src/cli/heap.ts:16-57`). |
| OTEL | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | Effect spans; see `packages/axiomsec/src/effect/observability.ts`. |
| Process state | `AXIOMSEC_DB`, `AXIOMSEC_CONFIG_CONTENT` | Point a run at a disposable DB/config without touching your real one. |

`axiomsec` below means either the built binary or `bun run --cwd packages/axiomsec dev --` followed by the subcommand. Use the binary for disposable workspaces; use `dev` when you are debugging the repo itself.

## 2. Isolation recipe

`AXIOMSEC_TEST_HOME` only changes `Global.Path.home`; it does **not** isolate data/config/cache/state (`packages/axiomsec/src/globals/global.ts:16-25`). Set XDG paths explicitly.

Build once from the repo root, then use the standalone binary in a disposable workspace:

```bash
REPO="$(pwd)"   # run from the repo root
bun run --cwd packages/axiomsec build --single --skip-install
BIN="$(find "$REPO/packages/axiomsec/dist" -path '*/bin/axiomsec*' -type f | head -1)"

TMP="$(mktemp -d)"
export XDG_DATA_HOME="$TMP/data"
export XDG_CONFIG_HOME="$TMP/config"
export XDG_CACHE_HOME="$TMP/cache"
export XDG_STATE_HOME="$TMP/state"
export AXIOMSEC_DB="$TMP/axiomsec.db"
export AXIOMSEC_TEST_HOME="$TMP/home"
export AXIOMSEC_DISABLE_MODELS_FETCH=1
export AXIOMSEC_DISABLE_AUTOUPDATE=1
export AXIOMSEC_DISABLE_CLAUDE_CODE=1
mkdir -p "$TMP/work" && cd "$TMP/work" && git init -q
"$BIN" --version
"$BIN" debug paths
```

If `find` returns nothing, inspect `packages/axiomsec/dist/` (the target name includes OS/arch). Confirm every path printed by `debug paths` is under `$TMP` before creating any state.

## 3. Symptom → instrument → layer

```text
Boot / TUI
├─ exits before UI
│  → --print-logs --log-level DEBUG; debug paths; debug config; log file
│  → layer: CLI bootstrap / config / global paths
├─ UI starts but no model
│  → providers/models; auth; AXIOMSEC_DISABLE_MODELS_FETCH; model picker
│  → layer: providers / auth / config
├─ UI clears to black and onboarding never appears
│  → initial sync RPCs lost before the worker listener; check the `rpc.ready` queue and ping in support/rpc.ts; SyncProvider stays `loading`
│  → layer: TUI RPC / worker startup
└─ worker or server failure
   → tui/worker.ts; Server.listen; attach; port/password
   → layer: TUI worker / server

Tool call
├─ invalid arguments
│  → tool wrapper Zod parse (tools/tool.ts:235-246); debug agent with the same params
│  → layer: tool schema or model output
├─ permission denied / not asked
│  → permission rules; defaults; debug agent bypass; run auto-reject
│  → layer: permissions / agent config
├─ no scope denial
│  → Guard call present? ask decision? active operation?
│  → layer: boundary / tool
├─ hangs
│  → timeout/abort; provider stream; network/subprocess
│  → layer: network / subprocess / provider
└─ truncated output
   → Truncate; metadata.outputPath; agent config
   → layer: tool wrapper / truncation

Operation state
├─ wrong active operation
│  → .axiomsec/operation/active; resolver precedence; session binding
│  → layer: operation resolver
├─ missing facts
│  → SQLite rows vs cyber/*.jsonl; projection append failures
│  → layer: cyber kernel / projection
└─ clobbered operation
   → slug collision; create whole-file writes
   → layer: operation create

Findings / proof
├─ not reportable
│  → kind/status/evidence_refs/replay/oracle
│  → layer: finding / oracle
└─ reportable but dubious
   → do the refs resolve? is replay signed? was the evidence captured?
   → layer: evidence / proof

Server / SDK
├─ connection refused
│  → bind/port/password; debug paths
│  → layer: network / server
├─ 404
│  → route registration; SDK generation; route group
│  → layer: server route / generated SDK
└─ schema mismatch
   → OpenAPI metadata; generated types; operationId
   → layer: OpenAPI / SDK

Build / release
├─ typecheck
│  → tsgo; generated types; path aliases
├─ build
│  → /tmp paths; Windows linker; models snapshot; migrations embedding
└─ release
   → conditional test gate; publish files; npm/Docker secrets; do not run locally
```

## 4. Layer map

| Layer | Key files | First instrument |
|---|---|---|
| TUI | `packages/axiomsec/src/cli/cmd/tui/` | `AXIOMSEC_SHOW_TTFD=1`, `--print-logs` |
| Server | `packages/axiomsec/src/server/` | `serve`, `curl`, server logs |
| Session loop | `packages/axiomsec/src/session/prompt.ts`, `processor.ts`, `llm.ts` | `--log-level DEBUG`, session rows |
| Tools | `packages/axiomsec/src/tools/` | `debug agent`, tool metadata |
| Domain core | `packages/axiomsec/src/core/` | `operation show`, `db query`, files |
| Storage | `packages/axiomsec/src/storage/` | `db path`, `db query` |
| Providers/auth | `packages/axiomsec/src/providers/`, `packages/axiomsec/src/auth/` | `providers`, `models`, auth file |
| SDK | `packages/sdk/src/v2/` | `curl`, OpenAPI spec |
| Build/release | `packages/axiomsec/script/`, `.github/workflows/` | build logs, workflow YAML |
| Config/flags | `packages/axiomsec/src/config/`, `packages/axiomsec/src/flags/flag.ts` | `debug config`, env vars |

## 5. Debugging without tests

### 5.1 Operation lifecycle

```bash
"$BIN" operation new "Debug op" --kind pentest --target http://127.0.0.1:PORT
"$BIN" operation list --format json
"$BIN" operation show --format json
```

Inspect `.axiomsec/operation/<slug>/` and the SQLite rows. This proves create/activate/projection behavior without a model.

### 5.2 Direct tool execution

```bash
"$BIN" debug agent security --tool scope --params '{"action":"status"}'
```

Requires a configured default model (the command creates a session and resolves a model, but does not call it). **Ask-level tools fail unless `--dangerously-skip-permissions` is passed; each bypass is printed.** Use only on a disposable workspace. For target-touching tools, prefer a loopback fixture.

### 5.3 Headless server

```bash
AXIOMSEC_SERVER_PASSWORD=canary "$BIN" serve --hostname 127.0.0.1 --port 4096
curl -s -u axiomsec:canary http://127.0.0.1:4096/config | head
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4096/config   # expect 401
```

Without a password, the server warns and serves unauthenticated (`packages/axiomsec/src/cli/cmd/serve.ts:11-12`). Never expose it beyond loopback while debugging.

### 5.4 Embedded TUI server

The TUI worker hosts the Hono app in-process (`packages/axiomsec/src/cli/cmd/tui/worker.ts:45-63`). There is no port unless you call `serve` or attach. Use the TUI logs and `debug agent` rather than assuming `localhost`.

### 5.5 Module-level checks (no test files)

For pure functions, run a one-liner with Bun from the repo root. Example:

```bash
bun -e 'import { isReportableFinding } from "./packages/axiomsec/src/core/cyber/finding.ts"; console.log(isReportableFinding({ kind: "finding", status: "verified", evidence_refs: ["x"], replay_present: false }))'
```

Use this for predicates, parsers, and formatters. For code that needs `Instance`/DB, use the CLI or a disposable operation instead. Do not commit these snippets as test files.

### 5.6 Evidence, replay, and SQLite

- `axiomsec operation show --format json` for projected state.
- `axiomsec db query "select ..." --format json` for canonical rows.
- `axiomsec replay show <file>` for a transcript; `verify` for body integrity.
- `.axiomsec/.../evidence/manifest.jsonl` for the evidence index and file names.

Corroborate across at least two of these before concluding.

## 6. Worked examples

### 6.1 Tool fails with “invalid arguments”

1. Read the wrapper validation at `packages/axiomsec/src/tools/tool.ts:235-246`.
2. Run the same params through `debug agent <agent> --tool <id> --params '<json>'`.
3. If it passes there, the model produced the wrong shape: inspect the tool description/few-shot context.
4. If it fails there, fix the Zod schema or the error message. Do not loosen validation just to accept the model’s output.

### 6.2 Scope is not enforced

1. Check whether the tool imports/calls `Guard.check*`.
2. If it does, inspect whether it treats `ask` as a prompt or metadata. Today, most tools call their own `ctx.ask`; the boundary `ask` is not a separate approval.
3. Check for an active operation and the active marker; no operation means allow (`packages/axiomsec/src/core/boundary/guard.ts:89`).
4. Reproduce with a disposable loopback operation and `Guard.check`; never send third-party traffic.

### 6.3 Finding is not reportable

1. `finding status <key>`: check `kind`, `status`, `evidence_refs`, `replay_present`, `oracle_status`.
2. If evidence refs are present, verify they exist in `evidence/manifest.jsonl` and that the files are readable. The oracle does not verify hashes.
3. If replay is missing, confirm whether a structured exemption was supplied with both category and rationale, and whether the category is valid for the operation kind.
4. Do not weaken `isReportableFinding` or the oracle to make the finding pass; fix the proof.

## 7. Windows-specific

- `/tmp` is hardcoded in `packages/axiomsec/drizzle.config.ts:8` and `packages/axiomsec/src/cli/cmd/replay.ts:122`. On Windows, `db generate` or replay signing can fail or write to an unexpected location.
- Git Bash path conversion and `AXIOMSEC_GIT_BASH_PATH` matter for `less`, git, and shell tools.
- Builds use `--linker hoisted` on Windows (`packages/axiomsec/script/build.ts:54`); CI setup does the same.
- `chmod 0600` does not have the same meaning on Windows; do not assume vault permissions are enforced by the OS.
- Path comparisons are case-insensitive on Windows; lexical containment and symlink/junction behavior differ.

## 8. Stop conditions

Stop and report instead of proceeding if:

- The reproduction would send traffic to a third-party host.
- Real credentials, customer data, or production evidence would enter logs, evidence, or a share bundle.
- State mutation could destroy a real operation, evidence artifact, or database.
- You cannot isolate the layer without disabling a security control (`Guard`, permissions, auth). Use a disposable environment instead.

Next: [VERIFICATION.md](VERIFICATION.md) for proof, [BUG-HUNTING.md](BUG-HUNTING.md) for proactive audits, [KNOWN-RISKS.md](KNOWN-RISKS.md) for known defects, [ARCHITECTURE.md](ARCHITECTURE.md) for the layer map in code.
