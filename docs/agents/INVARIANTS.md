# AxiomSec Invariants

Read when: changing scope, permissions, tools, evidence, findings, storage, server behavior, or build outputs.
This file is **rules**, not a defect list. Current violations live in [KNOWN-RISKS.md](KNOWN-RISKS.md).

An invariant is a design requirement. If code violates it, that is a bug or a documented risk — never a reason to rewrite the invariant to match the code.

## Security invariants

### SEC-01 — Authorized scope before any target traffic

- **Rule:** Before DNS resolution, a socket, a browser launch, or a target-touching subprocess, the request must be checked against the active operation’s boundary.
- **Why:** AxiomSec is an authorized-testing harness; one unguarded path makes every other control optional.
- **Enforced at:** `packages/axiomsec/src/core/boundary/guard.ts:87-118`; call sites in `packages/axiomsec/src/tools/http-request.ts`, `packages/axiomsec/src/tools/webfetch.ts`, `packages/axiomsec/src/tools/scanner.ts`, `packages/axiomsec/src/tools/appsec-probe.ts`.
- **Check:** Enumerate every egress path and confirm `Guard.check*` runs before I/O. A missing active operation returns `allow` (`packages/axiomsec/src/core/boundary/guard.ts:89`), so “no operation” is not a safe default for target work.
- **Known risk:** `RISK-SCOPE-01`, `RISK-SCOPE-02`.

### SEC-02 — Guard coverage is mandatory for new target-touching tools

- **Rule:** Any new tool that can reach a target — HTTP, TCP, browser, DNS, subprocess scanner — must call the appropriate `Guard.checkUrl` / `Guard.checkHost` / `Guard.checkPath` before acting.
- **Why:** Guard is a per-tool convention, not a runtime choke point. Adding a tool silently expands the unguarded surface.
- **Enforced at:** `packages/axiomsec/src/tools/http-request.ts:73-92`, `packages/axiomsec/src/tools/webfetch.ts:42-59`, `packages/axiomsec/src/tools/scanner.ts:577-596`, `packages/axiomsec/src/tools/appsec-probe.ts:649-652`.
- **Check:** `rg -n "Guard\\.(check|checkUrl|checkHost|checkPath)" packages/axiomsec/src/tools` vs `rg -n "fetch\\(|spawn\\(|playwright|net\\.connect" packages/axiomsec/src/tools`.
- **Known risk:** Current gaps are `browser`, `net`, and `bash` — `RISK-SCOPE-01`.

### SEC-03 — Permission before side effects

- **Rule:** Sensitive actions must call `ctx.ask` with the narrowest permission key and patterns. Do not widen defaults or bypass an ask to make a test pass.
- **Why:** The permission engine is the human control between the model and the machine. It only works if tools request it and rules resolve to `ask`.
- **Enforced at:** `packages/axiomsec/src/agent/agent.ts:110-127` (defaults), `packages/axiomsec/src/permissions/evaluate.ts:9-15` (last-match, default ask), `packages/axiomsec/src/session/prompt.ts:374` (plumbing), `packages/axiomsec/src/permissions/permission.ts` (approvals).
- **Check:** For every write/network/spawn tool, confirm `ctx.ask` exists and the permission key matches the tool id or a documented distinct key. Remember: built-in defaults are `"*": "allow"`; only `http_request` and `browser` are explicit asks in the cyber agents. `.env` protection exists only in the `read` rules; `bash` can read it.
- **Known risk:** `RISK-PERM-01`, `RISK-PERM-02`, `RISK-PERM-03`.

### SEC-04 — Evidence is immutable and content-addressed

- **Rule:** Evidence bytes are addressed by SHA-256; never mutate a stored file or hand-edit `manifest.jsonl`. New evidence gets a new hash.
- **Why:** Findings, reports, and replay lose their proof value if the artifact can change under the same reference.
- **Enforced at:** `packages/axiomsec/src/core/evidence/store.ts:55-103`; writes go through `Evidence.put`, reads through `Evidence.get`.
- **Check:** A finding/report evidence ref must resolve to a manifest entry and a file. `Evidence.get` currently does not re-hash bytes; treat that as a gap, not permission to mutate files.
- **Known risk:** `RISK-PROOF-01` (refs are not validated at promotion), `RISK-PERSIST-01` (unlocked manifest append).

### SEC-05 — Findings are reportable only with proof

- **Rule:** A finding is reportable only when `kind === "finding"`, `status === "verified"`, `evidence_refs` is non-empty, and either replay is present or a structured, domain-valid replay exemption exists.
- **Why:** The product’s differentiator is that the workflow does not let the agent overclaim.
- **Enforced at:** `packages/axiomsec/src/core/cyber/finding.ts:189-194`; `packages/axiomsec/src/core/cyber/oracle.ts:66-133`; promotion in `packages/axiomsec/src/tools/finding.ts:245-309`.
- **Check:** Never weaken the predicate or oracle to make a finding pass. `replay_present` means a replay artifact/string exists; it is **not** signature verification. Rejected/stale findings must remain visible, not disappear.
- **Known risk:** `RISK-PROOF-01`, `RISK-PROOF-02`.

### SEC-06 — Secrets are contained, minimized, and not logged

- **Rule:** Do not log Authorization/Cookie/API keys, do not put secrets in tool args when avoidable, and do not assume share/replay redaction removes them.
- **Why:** Tool args are ledgered; evidence can include request headers/cookies/bodies; share copies evidence/cyber/workflow/context. Redaction is narrow.
- **Enforced at:** `packages/axiomsec/src/tools/tool.ts:247-259` (ledger input), `packages/axiomsec/src/tools/vault.ts:59-74` (reveal), `packages/axiomsec/src/core/vault.ts:45-49` (0600 plaintext), `packages/axiomsec/src/tools/share.ts:41,54-60,141-168` (redaction), `packages/axiomsec/src/core/replay/redact.ts:13-39`.
- **Check:** Use canary strings on a disposable operation; build a share bundle; grep the tarball for the canary. Never use real credentials in verification.
- **Known risk:** `RISK-SECRET-01`, `RISK-SECRET-02`.

### SEC-07 — Server and MCP surfaces stay local and authenticated

- **Rule:** Do not expose the server beyond loopback without a password and an explicit operator decision. Do not assume OAuth callbacks are loopback-only.
- **Why:** The headless server can drive tools and read workspace data; an unauthenticated bind is remote code execution by another name.
- **Enforced at:** `packages/axiomsec/src/cli/network.ts:5-15` (defaults), `packages/axiomsec/src/server/middleware.ts:39-49` (optional auth), `packages/axiomsec/src/cli/cmd/serve.ts:11-12` (warning), `packages/axiomsec/src/mcp/oauth-callback.ts:187` (binds all interfaces).
- **Check:** `curl` the server with and without `AXIOMSEC_SERVER_PASSWORD`; inspect `--hostname` usage; read the OAuth callback bind before debugging MCP auth.
- **Known risk:** `RISK-NET-02`.

## Engineering invariants

### ENG-01 — Per-project state lives in Instance/InstanceState

- **Rule:** Do not add module-level `Map`/`Set`/singleton state for per-project or per-session data. Use `Instance` and `InstanceState` (or an Effect service with a scoped cache).
- **Why:** Module globals leak across projects, sessions, and concurrent test/dev instances.
- **Enforced at:** `packages/axiomsec/src/project/instance.ts:57-102`, `packages/axiomsec/src/effect/instance-state.ts`, `packages/axiomsec/src/effect/app-runtime.ts`.
- **Check:** Search for top-level `const ... = new Map(` / `new Set(` in `src/`; inspect whether the key includes project/session. Existing counterexamples: `packages/axiomsec/src/tools/browser.ts:80-81`, `packages/axiomsec/src/core/operation/operation.ts:26`.
- **Known risk:** `RISK-NET-01`, `RISK-PERSIST-03`.

### ENG-02 — SQLite cyber kernel is canonical

- **Rule:** Read and write operation truth through the kernel services (`Cyber`, `Operation`, `Evidence`, `Observation`, `Plan`, `Deliverable`). JSONL, context packs, markdown notebooks, and reports are projections.
- **Why:** Making a projection authoritative creates drift and lets one surface overwrite another.
- **Enforced at:** `packages/axiomsec/src/core/operation/operation.ts:1-14`; `packages/axiomsec/src/core/cyber/cyber.ts`; `packages/axiomsec/src/core/operation/snapshot.ts`.
- **Check:** New code must not parse/rewrite `.axiomsec` JSONL as the source of truth. If a projection is stale, rebuild it; do not “fix” the kernel from the projection.
- **Known risk:** `RISK-PERSIST-01`, `RISK-PERSIST-02`.

### ENG-03 — Every network and subprocess call has a timeout or abort

- **Rule:** Network requests, subprocess spawns, installers, signers, and archive tools must accept an `AbortSignal` or explicit timeout and surface a useful error.
- **Why:** The agent loop is long-lived; one hung call stalls a session and can exhaust resources.
- **Enforced at:** `packages/axiomsec/src/tools/http-request.ts:94-111` (timeout), `packages/axiomsec/src/tools/bash.ts` (abort/timeout), `packages/axiomsec/src/session/processor.ts:602-655` (semantic watchdog), `packages/axiomsec/src/session/llm.ts` provider timeouts.
- **Check:** `rg -n "fetch\\(|spawn\\(|spawnSync\\(|exec\\(" packages/axiomsec/src packages/sdk/src` and inspect each for a signal/timeout. Do not add a new bare call.
- **Known risk:** `RISK-TIME-01`.

### ENG-04 — The tool wrapper owns audit, workflow, context, and truncation

- **Rule:** Implement tools with `Tool.define`; do not bypass `Tool.wrap` or reimplement ledger/workflow/context behavior inside a tool.
- **Why:** The wrapper is the consistent audit and safety boundary: operation resolution, Zod validation, `tool.called`/`tool.completed`/`tool.error`, workflow progress, context refresh, truncation.
- **Enforced at:** `packages/axiomsec/src/tools/tool.ts:205-450`; registry assembly at `packages/axiomsec/src/tools/registry.ts:236-336`.
- **Check:** Read the wrapper before changing tool behavior. A new tool must declare `side_effects` and return `{ title, metadata, output }`; errors should be actionable, not silently swallowed.
- **Known risk:** Side-effect metadata is inconsistent across cyber tools — see `RISK-DOC-02`/leads.

### ENG-05 — Generated files and migrations are not hand-edited

- **Rule:** Treat `packages/sdk/src/v2/gen/*`, `packages/axiomsec/src/providers/models-snapshot.*`, applied migration SQL, and generated declarations as generated. Regenerate or add a new migration; never patch generated output.
- **Why:** Hand edits are lost on the next generation and create schema/client drift.
- **Enforced at:** `packages/axiomsec/script/generate.ts`, `packages/sdk/src/v2/gen/*`, `migration/`, `packages/axiomsec/script/build.ts:16-48`, `packages/axiomsec/src/storage/db.ts:96-112`.
- **Check:** `git diff` must not touch generated files unless the generator output is the intended artifact. `axiomsec db migrate` is JSON→SQLite data migration, **not** schema migration; schema migrations apply lazily on DB open. Never use `AXIOMSEC_SKIP_MIGRATIONS` on a real DB.
- **Known risk:** `RISK-BUILD-02` (missing SDK generator config), `RISK-BUILD-01` (`/tmp`).

### ENG-06 — Cross-platform, canonical paths

- **Rule:** Do not hardcode `/tmp`, POSIX-only path assumptions, or case-sensitive path logic. Canonicalize paths before containment checks.
- **Why:** Builds and dev run on Windows, macOS, Linux; lexical containment and `/tmp` are recurring failure sources.
- **Enforced at:** `packages/axiomsec/src/support/filesystem.ts:123-125` (containment), `packages/axiomsec/src/project/instance.ts:94-102`, `packages/axiomsec/script/build.ts:54` (Windows linker), `packages/axiomsec/src/cli/win32.ts`.
- **Check:** `rg -n "/tmp|C:\\\\|\\\\\\\\" packages/axiomsec/src packages/axiomsec/script`; test the affected path on the current platform; consider symlinks/junctions. `packages/axiomsec/drizzle.config.ts:8` and `packages/axiomsec/src/cli/cmd/replay.ts:122` are current violations.
- **Known risk:** `RISK-BUILD-01`, `RISK-PATH-01`.

### ENG-07 — Fail visibly on audit, proof, migration, and deletion paths

- **Rule:** Do not swallow errors that affect the ledger, evidence, findings, migrations, or destructive operations. Best-effort behavior is acceptable only for UI refresh/projection conveniences and must be visibly best-effort.
- **Why:** Silent failure turns a proof system into a confidence system.
- **Enforced at:** `packages/axiomsec/src/tools/tool.ts:247-360` (ledger), `packages/axiomsec/src/core/operation/operation.ts:26-31` (migration), `packages/axiomsec/src/core/evidence/store.ts` (manifest), `packages/axiomsec/src/core/cyber/cyber.ts` (projection appends).
- **Check:** Review every `.catch(() => ...)` near audit/proof/migration paths; if the failure can invalidate state, propagate it or record a visible warning. Do not add new swallowed errors for convenience.
- **Known risk:** `RISK-PERSIST-03`, projection/migration gaps in [KNOWN-RISKS.md](KNOWN-RISKS.md) leads.

## Invariant change protocol

1. If a requirement genuinely changes, update this file, the affected risk entry, the verification scenario, and the code in the same PR.
2. If code intentionally keeps an exception, record it in `KNOWN-RISKS.md` with a status, date, and re-verify command. Do not describe a bug as intended behavior.
3. If code and this document disagree, code is the current truth; verify it, then fix the doc or the code. Never weaken an invariant silently.

Next: [DEBUGGING.md](DEBUGGING.md) for failures, [BUG-HUNTING.md](BUG-HUNTING.md) for audits, [VERIFICATION.md](VERIFICATION.md) for proof, [KNOWN-RISKS.md](KNOWN-RISKS.md) for current violations, [ARCHITECTURE.md](ARCHITECTURE.md) for mechanisms.
