# AxiomSec Invariants

Read when: changing scope, permissions, tools, evidence, findings, storage, server behavior, or build outputs.
This file is **rules**, not a defect list. Current violations live in [KNOWN-RISKS.md](KNOWN-RISKS.md).

An invariant is a design requirement. If code violates it, that is a bug or a documented risk — never a reason to rewrite the invariant to match the code.

## Security invariants

### SEC-01 — Authorized scope before any target traffic

- **Rule:** Before DNS resolution, a socket, a browser launch, or a target-touching subprocess, the request must be checked against the active operation’s boundary.
- **Why:** AxiomSec is an authorized-testing harness; one unguarded path makes every other control optional.
- **Enforced at:** `packages/axiomsec/src/core/boundary/guard.ts:87-118`; call sites in `packages/axiomsec/src/tools/http-request.ts`, `webfetch.ts`, `scanner.ts`, `appsec-probe.ts`, `browser.ts:233-247,256-269,953-960`, `net.ts:113-121`, and the redirect loop in `packages/axiomsec/src/tools/guarded-http.ts:45-79`. Scanner crawl/JS subresources go through `scanner.ts:602-618` and `packages/axiomsec/src/scanners/http.ts`.
- **Check:** Enumerate every egress path and confirm `Guard.check*` runs before I/O, including each redirect hop and every discovered scanner subresource. Scanner crawl/JS and dir-fuzz pass an `allowUrl` callback; `appsec_probe` checks every planned route, not just the origin. A boundary `ask` must trigger the separate `scope` permission (default `ask`) before the request; a missing active operation returns `allow` (`packages/axiomsec/src/core/boundary/guard.ts:89`), so “no operation” is not a safe default for target work. An operation slug must also stay inside `.axiomsec/operation/` (`packages/axiomsec/src/core/operation/slug.ts`).
- **Known risk:** `RISK-SCOPE-01`, `RISK-SCOPE-03` (`bash`); `RISK-SCOPE-02` fixed 2026-10-21; `RISK-SCOPE-04/05/06/07` fixed 2026-10-22; `RISK-SCOPE-08` (case-insensitive host patterns), `RISK-SCOPE-09` (dir-fuzz paths), `RISK-SCOPE-10` (appsec probe routes) and `RISK-SCOPE-11` (WebRTC/WebTransport egress) fixed 2026-10-22.

### SEC-02 — Guard coverage is mandatory for new target-touching tools

- **Rule:** Any new tool that can reach a target — HTTP, TCP, browser, DNS, subprocess scanner — must call the appropriate `Guard.checkUrl` / `Guard.checkHost` / `Guard.checkPath` before acting.
- **Why:** Guard is a per-tool convention, not a runtime choke point. Adding a tool silently expands the unguarded surface.
- **Enforced at:** `packages/axiomsec/src/tools/http-request.ts:73-92`, `packages/axiomsec/src/tools/webfetch.ts:42-59`, `packages/axiomsec/src/tools/scanner.ts:577-596,602-618`, `packages/axiomsec/src/tools/appsec-probe.ts:649-652`, `packages/axiomsec/src/tools/browser.ts:233-247,256-269,953-960`, `packages/axiomsec/src/tools/net.ts:113-121`, and `packages/axiomsec/src/tools/guarded-http.ts:45-79`.
- **Check:** `rg -n "Guard\\.(check|checkUrl|checkHost|checkPath)" packages/axiomsec/src/tools` vs `rg -n "fetch\\(|spawn\\(|playwright|net\\.connect" packages/axiomsec/src/tools`; when a fetch can redirect or discover subresources, verify the guard runs inside the loop (`guarded-http.ts`) or via an `allowUrl` callback (`scanners/http.ts`). In the browser, HTTP, WebSocket and service-worker requests go through the context routes; `RTCPeerConnection` and `WebTransport` are disabled by an init script because they use UDP/QUIC and bypass Playwright routing.
- **Known risk:** `bash` remains unguarded — `RISK-SCOPE-03`; `RISK-SCOPE-01` for the per-tool model.

### SEC-03 — Permission before side effects

- **Rule:** Sensitive actions must call `ctx.ask` with the narrowest permission key and patterns. Do not widen defaults or bypass an ask to make a test pass.
- **Why:** The permission engine is the human control between the model and the machine. It only works if tools request it and rules resolve to `ask`.
- **Enforced at:** `packages/axiomsec/src/agent/agent.ts:110-140` (defaults), `packages/axiomsec/src/permissions/evaluate.ts:9-15` (last match, default ask), `packages/axiomsec/src/permissions/permission.ts` (`decide` — the live ruleset decides first, a stored “always” approval satisfies an `ask` second, an explicit `deny` always wins), `packages/axiomsec/src/session/prompt.ts:374` (plumbing), `packages/axiomsec/src/permissions/permission.ts` (approvals), `packages/axiomsec/src/tools/vault.ts:41,71,103,162`, `packages/axiomsec/src/tools/identity.ts:94,150,206`, `packages/axiomsec/src/tools/interact.ts:90-97`, `packages/axiomsec/src/tools/evidence.ts:246-257`, `packages/axiomsec/src/tools/binary-triage.ts:90-100`, `packages/axiomsec/src/tools/iac-triage.ts:98-109`, `packages/axiomsec/src/tools/opsec.ts`, `packages/axiomsec/src/tools/scope.ts`, `packages/axiomsec/src/tools/finding.ts`, `packages/axiomsec/src/tools/observation.ts`, `packages/axiomsec/src/tools/question.ts`, `packages/axiomsec/src/tools/plan.ts`.
- **Check:** For every write/network/spawn/secret tool, confirm `ctx.ask` exists and the permission key matches the tool id or a documented distinct key. Network, shell, secret, and operation-record tools default to `ask`; a `deny` rule removes the tool from the registry (`packages/axiomsec/src/tools/registry.ts`) and is never overridden by a stored “always” approval. `.env` protection exists in the `read` rules, and `bash`, `interact`, and user-path triage/evidence reads ask before touching files.
- **Known risk:** `RISK-PERM-04`, `RISK-PERM-03`; `RISK-PERM-01` and `RISK-PERM-02` fixed 2026-10-21; `RISK-PERM-07` and `RISK-PERM-08` fixed 2026-10-22. `RISK-PERM-09` (autonomy self-elevation), `RISK-PERM-10` (adapter triage defaults), `RISK-PERM-11` (per-prompt toggles replacing session policy), `RISK-SESSION-02` (ignored subagent asks), `RISK-SESSION-03` (fork parent/permission loss), and `RISK-MCP-01` (MCP permission namespace) fixed 2026-10-22.

### SEC-04 — Evidence is immutable and content-addressed

- **Rule:** Evidence bytes are addressed by SHA-256; never mutate a stored file or hand-edit `manifest.jsonl`. New evidence gets a new hash.
- **Why:** Findings, reports, and replay lose their proof value if the artifact can change under the same reference.
- **Enforced at:** `packages/axiomsec/src/core/evidence/store.ts`; writes go through `Evidence.put` (temp file + rename, so a crash cannot truncate an artifact under a digest that says it is complete), reads through `Evidence.get`, integrity through `Evidence.verify`. A malformed manifest line is skipped and reported, never fatal.
- **Check:** A finding/report evidence ref must resolve to a manifest entry and a file whose bytes re-hash to the ref. Promotion rejects unknown or tampered refs (`packages/axiomsec/src/tools/finding.ts`).
- **Known risk:** none open; `RISK-PERSIST-01` and `RISK-PROOF-01` fixed 2026-10-21; `RISK-PERSIST-05` fixed 2026-10-22.

### SEC-05 — Findings are reportable only with proof

- **Rule:** A finding is reportable only when `kind === "finding"`, `status === "verified"`, `evidence_refs` is non-empty and resolves to an artifact, and either replay is present or a structured, domain-valid replay exemption exists. **Replay steps are not evidence**: the replay artifact is tracked separately and never counts toward the evidence set.
- **Why:** The product’s differentiator is that the workflow does not let the agent overclaim. If one model-authored string could satisfy both halves of the proof AND, the agent could self-certify its own findings.
- **Enforced at:** `packages/axiomsec/src/core/cyber/finding.ts:189-194`; `packages/axiomsec/src/core/cyber/oracle.ts:66-133`; the promotion evidence gate in `packages/axiomsec/src/tools/finding.ts` (independent evidence required, then `ctx.ask`).
- **Check:** Never weaken the predicate or oracle to make a finding pass. Every promotion evidence ref must resolve through `Evidence.verify` and must not be the replay artifact; `replay_present` means a replay artifact/string exists and is **not** signature verification. Signed replays are verified by `replay verify` only when a public key is configured. Rejected/stale findings must remain visible, not disappear, and a candidate must not be counted as a suspected finding.
- **Known risk:** none open; `RISK-PROOF-01` and `RISK-PROOF-02` fixed 2026-10-21; `RISK-PROOF-03`, `RISK-PROOF-04`, `RISK-PROOF-05`, `RISK-PROOF-06` (blank evidence refs) fixed 2026-10-22.

### SEC-06 — Secrets are contained, minimized, and not logged

- **Rule:** Do not log Authorization/Cookie/API keys, do not put secrets in tool args when avoidable, and do not assume share/replay redaction removes them.
- **Why:** Tool args are ledgered **and persisted in the session database**; evidence can include request headers/cookies/bodies; share copies evidence/cyber/workflow/context. Redaction covers structured JSON/JSONL and common text secrets, but binary/unknown formats and positional CSV values are not scanned.
- **Enforced at:** `packages/axiomsec/src/tools/tool.ts:108-122` (`redactToolInput` — used for the ledger, the workflow record, and the persisted session tool part), `packages/axiomsec/src/tools/vault.ts:41,71,103,162` (vault asks), `packages/axiomsec/src/tools/identity.ts:94,150,206` (identity asks), `packages/axiomsec/src/tools/vault.ts` (no value in ledger data), `packages/axiomsec/src/core/vault.ts:45-49` (0600 plaintext), `packages/axiomsec/src/tools/share.ts:41-99,215-216` (staged-tree redaction), `packages/axiomsec/src/core/replay/redact.ts` (structured and text redaction, including a sensitive key whose value is an object or array).
- **Check:** Use canary strings on a disposable operation; build a share bundle with `redact:true` and `redact:false`; grep the tarballs for the canary; grep the session database for the canary after a `vault set`. Never use real credentials in verification.
- **Known risk:** `RISK-SECRET-03`; `RISK-SECRET-01` and `RISK-SECRET-02` fixed 2026-10-21; `RISK-SECRET-04`, `RISK-SECRET-05` (including the processor first-write residual) and `RISK-SECRET-06` (inline/replay-error redaction) fixed 2026-10-22.

### SEC-07 — Server and MCP surfaces stay local and authenticated

- **Rule:** The server refuses non-loopback binds without a password. Do not expose the server beyond loopback without an explicit operator decision. Do not assume OAuth callbacks are loopback-only unless the bind is explicit.
- **Why:** The headless server can drive tools and read workspace data; an unauthenticated bind is remote code execution by another name.
- **Enforced at:** `packages/axiomsec/src/cli/cmd/serve.ts:11-18,29-33` (non-loopback password gate), `packages/axiomsec/src/cli/network.ts:5-15` (loopback default), `packages/axiomsec/src/server/middleware.ts:39-49` (auth when configured), `packages/axiomsec/src/mcp/oauth-callback.ts:187` (loopback bind).
- **Check:** `curl` the loopback server with and without `AXIOMSEC_SERVER_PASSWORD`; a URL `auth_token` must return 401 while Basic auth succeeds; run `serve --hostname 0.0.0.0` without a password and confirm exit 1; read the OAuth callback bind before debugging MCP auth.
- **Known risk:** none open; `RISK-NET-02` and `RISK-NET-03` fixed 2026-10-21.

## Engineering invariants

### ENG-01 — Per-project state lives in Instance/InstanceState

- **Rule:** Do not add module-level `Map`/`Set`/singleton state for per-project or per-session data. Use `Instance` and `InstanceState` (or an Effect service with a scoped cache).
- **Why:** Module globals leak across projects, sessions, and concurrent test/dev instances.
- **Enforced at:** `packages/axiomsec/src/project/instance.ts:57-102`, `packages/axiomsec/src/effect/instance-state.ts`, `packages/axiomsec/src/effect/app-runtime.ts`.
- **Check:** Search for top-level `const ... = new Map(` / `new Set(` in `src/`; inspect whether the key includes project/session. Browser sessions are keyed by workspace + operation + TLS mode and close the previous session on switch, but the registry is still process-global by design (`packages/axiomsec/src/tools/browser.ts:143-149`). The migration memo is per-process (`operation.ts:27-29`).
- **Known risk:** none open; `RISK-NET-01` and `RISK-PERSIST-03` fixed 2026-10-21.

### ENG-02 — SQLite cyber kernel is canonical

- **Rule:** Read and write operation truth through the kernel services (`Cyber`, `Operation`, `Evidence`, `Observation`, `Plan`, `Deliverable`). JSONL, context packs, markdown notebooks, and reports are projections.
- **Why:** Making a projection authoritative creates drift and lets one surface overwrite another.
- **Enforced at:** `packages/axiomsec/src/core/operation/operation.ts:1-14`; `packages/axiomsec/src/core/cyber/cyber.ts`; `packages/axiomsec/src/core/operation/snapshot.ts`. Operation state and the scope policy are written to the database first and mirrored into the projection (`packages/axiomsec/src/core/operation/operation.ts`, `writeOperationFacts`); reads prefer the database and fall back to the projection only for operations created by an older build. Fact and relation writes are single atomic upserts (`onConflictDoUpdate`).
- **Check:** New code must not parse/rewrite `.axiomsec` JSONL as the source of truth. If a projection is stale, rebuild it; do not “fix” the kernel from the projection. Projection and manifest appends take the shared file lock (`support/lock.ts`).
- **Known risk:** none open; `RISK-PERSIST-01` and `RISK-PERSIST-02` fixed 2026-10-21; `RISK-PERSIST-04`, `RISK-PERSIST-08`, `RISK-PERSIST-09` fixed 2026-10-22.

### ENG-03 — Every network and subprocess call has a timeout or abort

- **Rule:** Network requests, subprocess spawns, installers, signers, and archive tools must accept an `AbortSignal` or explicit timeout and surface a useful error.
- **Why:** The agent loop is long-lived; one hung call stalls a session and can exhaust resources.
- **Enforced at:** `packages/axiomsec/src/tools/http-request.ts:94-111` (timeout), `packages/axiomsec/src/tools/bash.ts` (abort/timeout), `packages/axiomsec/src/tools/share.ts:136,145,245-247` (signer/tar bounds), `packages/axiomsec/src/npm/npm.ts:43` (registry timeout), `packages/axiomsec/src/installer/installation.ts:113,133,168` (installer bounds), `packages/axiomsec/src/tools/process.ts:3-16` (triage adapter bound), `packages/axiomsec/src/session/processor.ts:602-655` (semantic watchdog), `packages/axiomsec/src/session/llm.ts` provider timeouts.
- **Check:** `rg -n "fetch\\(|spawn\\(|spawnSync\\(|exec\\(" packages/axiomsec/src packages/sdk/src` and inspect each for a signal/timeout. Do not add a new bare call. SDK streaming keeps `req.timeout=false` intentionally; callers must cancel.
- **Known risk:** none open; `RISK-TIME-01` fixed 2026-10-21 (SDK streaming residual); `RISK-TIME-03` (bounded retries, permanent-quota fail-fast, non-zero run exit) fixed 2026-10-22.

### ENG-04 — The tool wrapper owns audit, workflow, context, and truncation

- **Rule:** Implement tools with `Tool.define`; do not bypass `Tool.wrap` or reimplement ledger/workflow/context behavior inside a tool.
- **Why:** The wrapper is the consistent audit and safety boundary: operation resolution, Zod validation, `tool.called`/`tool.completed`/`tool.error`, workflow progress, context refresh, truncation.
- **Enforced at:** `packages/axiomsec/src/tools/tool.ts:205-450`; registry assembly at `packages/axiomsec/src/tools/registry.ts:236-336`. Plugin and config-file tools are wrapped through `Tool.wrapDef` (`packages/axiomsec/src/tools/tool.ts`), so they get validation, the ledger, workflow progress and context refresh like the built-ins. The wrapper ledgers `tool.called` before validation and records `tool.error` for a validation failure. MCP tools are ledgered on success and failure in `packages/axiomsec/src/session/prompt.ts`.
- **Check:** Read the wrapper before changing tool behavior. A new tool must declare `side_effects` and return `{ title, metadata, output }`; errors should be actionable, not silently swallowed.
- **Known risk:** `RISK-AUDIT-04` (a ledger write can still fail open, but the completion path now logs it and reports `audit_logged: false`). Side-effect metadata is enforced centrally by `DEFAULT_SIDE_EFFECTS` and the policy suite (`RISK-AUDIT-03` fixed 2026-10-22); validation/MCP failure auditing is covered by `RISK-AUDIT-05` and `RISK-AUDIT-06` (fixed 2026-10-22).

### ENG-05 — Generated files and migrations are not hand-edited

- **Rule:** Treat `packages/sdk/src/v2/gen/*`, `packages/axiomsec/src/providers/models-snapshot.*`, applied migration SQL, and generated declarations as generated. Regenerate or add a new migration; never patch generated output.
- **Why:** Hand edits are lost on the next generation and create schema/client drift.
- **Enforced at:** `packages/axiomsec/script/generate.ts`, `packages/sdk/src/v2/gen/*`, `migration/`, `packages/axiomsec/script/build.ts:16-48`, `packages/axiomsec/src/storage/db.ts:96-112`.
- **Check:** `git diff` must not touch generated files unless the generator output is the intended artifact. `axiomsec db migrate` is JSON→SQLite data migration, **not** schema migration; schema migrations apply lazily on DB open. Never use `AXIOMSEC_SKIP_MIGRATIONS` on a real DB.
- **Known risk:** `RISK-BUILD-02` (missing SDK generator config), `RISK-BUILD-01` (`/tmp`).

### ENG-06 — Cross-platform, canonical paths

- **Rule:** Do not hardcode `/tmp`, POSIX-only path assumptions, or case-sensitive path logic. Canonicalize paths before containment checks.
- **Why:** Builds and dev run on Windows, macOS, Linux; lexical containment and `/tmp` are recurring failure sources.
- **Enforced at:** `packages/shared/src/filesystem.ts:227-247` (canonical containment used by `Instance.containsPath`), `packages/axiomsec/src/project/instance.ts:94-102`, `packages/axiomsec/src/support/filesystem.ts:123-143` (plugin/TUI containment), `packages/axiomsec/script/build.ts:54` (Windows linker), `packages/axiomsec/src/cli/win32.ts`.
- **Check:** `rg -n "/tmp|C:\\\\|\\\\\\\\" packages/axiomsec/src packages/axiomsec/script`; test the affected path on the current platform; include a symlink/junction escape case.
- **Known risk:** none open; `RISK-BUILD-01` and `RISK-PATH-01` fixed 2026-10-21.

### ENG-07 — Fail visibly on audit, proof, migration, and deletion paths

- **Rule:** Do not swallow errors that affect the ledger, evidence, findings, migrations, or destructive operations. Best-effort behavior is acceptable only for UI refresh/projection conveniences and must be visibly best-effort.
- **Why:** Silent failure turns a proof system into a confidence system.
- **Enforced at:** `packages/axiomsec/src/tools/tool.ts:247-360` (ledger), `packages/axiomsec/src/core/operation/operation.ts:27-46` (migration retry/log), `packages/axiomsec/src/core/operation/migration.ts:73-86` (aggregate failures), `packages/axiomsec/src/core/evidence/store.ts` (manifest: a malformed line is counted and reported, the remaining entries stay readable), `packages/axiomsec/src/core/cyber/cyber.ts` (projection appends).
- **Check:** Review every `.catch(() => ...)` near audit/proof/migration paths; if the failure can invalidate state, propagate it or record a visible warning. Do not add new swallowed errors for convenience. A read that cannot be trusted must degrade loudly (a skipped manifest line is logged, not silently dropped).
- **Known risk:** `RISK-AUDIT-04` (ledger failures are still swallowed in the wrapper) open; `RISK-PERSIST-03` fixed 2026-10-21; `RISK-PERSIST-10` (dead-owner lock recovery) and `RISK-PERSIST-11` (evidence concurrency/extension containment) fixed 2026-10-22.

## Invariant change protocol

1. If a requirement genuinely changes, update this file, the affected risk entry, the verification scenario, and the code in the same PR.
2. If code intentionally keeps an exception, record it in `KNOWN-RISKS.md` with a status, date, and re-verify command. Do not describe a bug as intended behavior.
3. If code and this document disagree, code is the current truth; verify it, then fix the doc or the code. Never weaken an invariant silently.

Next: [DEBUGGING.md](DEBUGGING.md) for failures, [BUG-HUNTING.md](BUG-HUNTING.md) for audits, [VERIFICATION.md](VERIFICATION.md) for proof, [KNOWN-RISKS.md](KNOWN-RISKS.md) for current violations, [ARCHITECTURE.md](ARCHITECTURE.md) for mechanisms.
