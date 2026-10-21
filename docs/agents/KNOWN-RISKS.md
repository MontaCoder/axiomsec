# AxiomSec Known Risks

> **Dated register.** Baseline: commit `d1a6a18`, verified 2026-10-21. Line numbers are anchors, not truth. Re-read every cited line before relying on it. If code moved, update the citation and date in the same change. If you cannot verify an entry, mark it `stale`; do not silently trust it.

This register documents risks; it does not fix them unless an entry is marked `fixed`. It makes risks visible so future agents do not rediscover them the hard way.

## Legend

- **Severity:** `critical` — silent scope/permission/proof bypass or secret leak; `high` — cross-session leakage, auth exposure, data loss, or false verification with modest effort; `medium` — reliability/platform/dependency gap with a workaround; `low` — docs/tooling drift that wastes agent time.
- **Status:** `open` (verified, unresolved), `needs-verify` (code-read but impact not reproduced), `accepted` (known tradeoff), `fixed` (with date/commit), `stale` (cannot re-verify).
- **Safe checks only:** loopback fixtures, disposable workspaces, canary strings. No third-party targets, no real credentials, no exploit payloads.

## Critical

### RISK-SCOPE-01 — Guard is per-tool, not a runtime choke point

**Status:** open · **Severity:** critical · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/core/boundary/guard.ts:87-118`; call sites in `packages/axiomsec/src/tools/http-request.ts:74`, `packages/axiomsec/src/tools/webfetch.ts:43`, `packages/axiomsec/src/tools/scanner.ts:578`, `packages/axiomsec/src/tools/appsec-probe.ts:649`; no Guard import in `packages/axiomsec/src/tools/browser.ts`, `packages/axiomsec/src/tools/net.ts`, or `packages/axiomsec/src/tools/bash.ts`.
**Why it matters:** A new or existing egress path can bypass the active operation’s boundary entirely. `bash` can reach anything the process can; `browser` and `net` can send traffic without a boundary decision.
**Re-verify:** `rg -n "Guard\\.(check|checkUrl|checkHost|checkPath)" packages/axiomsec/src/tools` and `rg -n "fetch\\(|spawn\\(|Bun\\.spawn|playwright|net\\.connect" packages/axiomsec/src/tools`.
**Safe check:** Read the call sites; do not generate traffic. A disposable loopback fixture is acceptable for a future fix.
**Fix direction:** Move Guard invocation into a shared execution choke point for target-touching tools, or require every such tool to call it and add a static check.
**Related:** `SEC-01`, `SEC-02`, `V-S3`.

### RISK-SCOPE-02 — Boundary `ask` is not an independent approval

**Status:** open · **Severity:** critical · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/core/boundary/guard.ts:89` (no active op → allow), `:103-117` (`ask` is returned, only `deny` throws); callers record `scope.mode` then call their own `ctx.ask` (`packages/axiomsec/src/tools/http-request.ts:73-92`, `packages/axiomsec/src/tools/scanner.ts:577-596`).
**Why it matters:** A request that is outside `in_scope` but not explicitly `out_of_scope` yields `ask`. The tool’s own permission may be auto-allowed by the built-in `"*": "allow"` default, so the boundary `ask` never becomes a human decision. With no active operation, the guard allows everything.
**Re-verify:** `sed -n '87,118p' packages/axiomsec/src/core/boundary/guard.ts` and `sed -n '73,92p' packages/axiomsec/src/tools/http-request.ts`.
**Safe check:** Create a disposable loopback operation with a boundary `default: ask`; call `Guard.check` directly and observe `mode: ask`. Do not contact a third-party host.
**Fix direction:** Treat boundary `ask` as an explicit permission request (or deny), not metadata; require an active operation for target-touching tools.
**Related:** `SEC-01`, `SEC-03`, `RISK-PERM-01`, `V-S3`.

### RISK-PERM-01 — Built-in permission defaults are allow-all

**Status:** open · **Severity:** critical · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/agent/agent.ts:110-127` (`"*": "allow"`), explicit asks only for `http_request`/`browser` at `:143-144`, `:166-167`, `:189-190`, `:213-214`, `:248-249`; `packages/axiomsec/src/permissions/evaluate.ts:9-15` (last match, default `ask` only when no rule matches); `packages/axiomsec/src/tools/vault.ts:59-74` (reveal without ask); `packages/axiomsec/src/tools/scanner.ts:585-596`, `packages/axiomsec/src/tools/net.ts:111-112`, `packages/axiomsec/src/tools/bash.ts:267-277` (asks whose default rule is allow).
**Why it matters:** Most built-in tools execute without a prompt under the default agent configuration. The `.env` protection exists only in the `read` rules; `bash` can read the same file. This is the difference between a permission system and a logging system.
**Re-verify:** `sed -n '110,127p' packages/axiomsec/src/agent/agent.ts`; `sed -n '9,15p' packages/axiomsec/src/permissions/evaluate.ts`; `rg -n "ctx\\.ask" packages/axiomsec/src/tools/{scanner,webfetch,net,bash,vault,identity}.ts`.
**Safe check:** Rule inspection only. Do not run `vault get --reveal` or network tools on a real workspace.
**Fix direction:** Default to ask for network/shell/secret tools; add explicit denies/asks per agent; make `.env` protection tool-independent.
**Related:** `SEC-03`, `RISK-SCOPE-02`, `RISK-PERM-02`, `V-S3`.

### RISK-PROOF-01 — Finding promotion trusts arbitrary evidence refs

**Status:** open · **Severity:** critical · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/tools/finding.ts:24-36` (`evidence: string[]`), `:245-309` (refs accepted, only length checked), `packages/axiomsec/src/core/cyber/oracle.ts:77-83` (non-empty refs satisfy the evidence gate), `packages/axiomsec/src/core/cyber/finding.ts:189-194` (reportable predicate).
**Why it matters:** A finding can be promoted as `verified`/reportable with fabricated 64-hex strings and a replay string, because the oracle does not resolve the refs to evidence files or compare hashes. That defeats the proof-first design.
**Re-verify:** `sed -n '24,36p;245,309p' packages/axiomsec/src/tools/finding.ts`; `sed -n '66,90p' packages/axiomsec/src/core/cyber/oracle.ts`.
**Safe check:** On a disposable operation, promote a finding with a fabricated hash and a short replay string, then inspect `finding status`. Never use real evidence.
**Fix direction:** Resolve every ref through `Evidence.get`, verify the manifest entry and bytes, and reject unknown refs before the oracle.
**Related:** `SEC-04`, `SEC-05`, `V-S4`.

### RISK-SECRET-01 — Share redaction is narrow

**Status:** open · **Severity:** critical · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/tools/share.ts:41` (`REDACT_EXTS` is only `.md`, `.txt`, `.json`, `.log`, `.yml`, `.yaml`, `.csv`), `:54-60` (applies `redactString`), `:141-168` (copies evidence/cyber/workflow/context and redacts staged files); `packages/axiomsec/src/core/replay/redact.ts:13-20` (JWT-only string redaction); `packages/axiomsec/src/tools/http-request.ts:159-196` (evidence stores merged headers, cookies, body).
**Why it matters:** A share bundle can include `.jsonl` ledger/fact projections, `.har`/`.html` evidence, and JSON containing Authorization/Cookie/API-key values. Redaction removes JWTs and selected text, not structure-aware secrets.
**Re-verify:** `sed -n '41,60p;141,168p' packages/axiomsec/src/tools/share.ts`; `sed -n '13,39p' packages/axiomsec/src/core/replay/redact.ts`.
**Safe check:** Put a canary `Authorization: Bearer canary-...` in a disposable evidence JSON/HAR, build a share bundle with redaction on, and grep the tarball. No real secrets.
**Fix direction:** Apply structured `redactValue` to JSON/JSONL, expand the extension set, and redact evidence at capture time (or at least on copy).
**Related:** `SEC-06`, `RISK-SECRET-02`, `V-S6`.

## High

### RISK-PERM-02 — `debug agent` turns `ask` into allow

**Status:** open · **Severity:** high · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/cli/cmd/debug/agent.ts:181-190` — the synthetic context’s `ask` throws only for an explicit `deny`; `allow` and `ask` both proceed.
**Why it matters:** It is a useful tool smoke-test, but dangerous on a real workspace or target: the operator sees no prompt.
**Re-verify:** `sed -n '181,190p' packages/axiomsec/src/cli/cmd/debug/agent.ts`.
**Safe check:** Run only read-only tools (`scope`, `workspace`) on a disposable workspace; never on a real target.
**Fix direction:** Make `debug agent` require an explicit `--dangerously-skip-permissions` for ask-level tools, or print the bypassed asks.
**Related:** `SEC-03`, `RISK-PERM-01`, `V-S3`.

### RISK-PERM-03 — `run --dangerously-skip-permissions` auto-approves

**Status:** open · **Severity:** high · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/cli/cmd/run.ts:544-548` replies `once` to every `permission.asked`; without the flag it auto-rejects (`:549-558`).
**Why it matters:** A non-interactive run with this flag can execute any side-effecting tool the model chooses, subject only to explicit deny rules and Guard coverage.
**Re-verify:** `sed -n '535,560p' packages/axiomsec/src/cli/cmd/run.ts`.
**Safe check:** Read-only inspection; do not run it against a real workspace.
**Fix direction:** Restrict the flag to disposable workspaces, print a prominent banner, and never combine with real credentials.
**Related:** `SEC-03`, `V-S3`.

### RISK-PROOF-02 — Replay signatures are produced but not verified

**Status:** open · **Severity:** high · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/cli/cmd/replay.ts:93-113` — `verify` checks `sha256_body`; if signed, it prints “verification not yet implemented”.
**Why it matters:** A signature in a replay trailer creates false assurance. Integrity is body-hash only; provenance is not established.
**Re-verify:** `sed -n '93,113p' packages/axiomsec/src/cli/cmd/replay.ts`.
**Safe check:** Read the command; use `replay verify` on a disposable replay and observe the message.
**Fix direction:** Implement minisign/cosign verification or label signatures as unverified in `show`/`verify` and reports.
**Related:** `SEC-05`, `V-S7`.

### RISK-SECRET-02 — Tool args are ledgered; vault reveal has no ask

**Status:** open · **Severity:** high · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/tools/tool.ts:247-259` (`tool.called` data includes `input: args`); `packages/axiomsec/src/tools/vault.ts:59-74` (`get --reveal` returns the value; no `ctx.ask`), `:38-56` (`set` writes the value); `packages/axiomsec/src/core/vault.ts:45-49` (plaintext JSON, 0600).
**Why it matters:** `vault set`, `identity add`, `http_request` headers/cookies, and similar arguments can persist secrets in SQLite/JSONL and later in share bundles. The vault is not encrypted at rest, and reveal is not gated.
**Re-verify:** `sed -n '247,259p' packages/axiomsec/src/tools/tool.ts`; `sed -n '28,74p' packages/axiomsec/src/tools/vault.ts`; `sed -n '45,49p' packages/axiomsec/src/core/vault.ts`.
**Safe check:** Use a canary value in a disposable operation; inspect the ledger; do not set a real secret.
**Fix direction:** Add arg redaction for secret-bearing tools before ledgering, add `ctx.ask` to vault reveal/set, and consider OS keychain integration.
**Related:** `SEC-06`, `RISK-SECRET-01`, `V-S4`.

### RISK-NET-01 — Browser state is global and TLS errors are ignored

**Status:** open · **Severity:** high · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/tools/browser.ts:80-81` (module-level `sessions` Map + counter), `:137-140` (`ensure` reuses sessions), `:220` (`ignoreHTTPSErrors: true`).
**Why it matters:** Cookies/localStorage/headers/console buffers can persist across sessions and operations; unconditional TLS bypass makes a MITM invisible.
**Re-verify:** `sed -n '80,81p;137,140p;220p' packages/axiomsec/src/tools/browser.ts`.
**Safe check:** Read the code; do not launch a browser against a real target.
**Fix direction:** Scope browser contexts to `Instance`/operation and abort; make TLS bypass explicit and opt-in.
**Related:** `ENG-01`, `SEC-01`, `V-S3`.

### RISK-NET-02 — Server auth is optional; OAuth callback binds all interfaces

**Status:** open · **Severity:** high · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/server/middleware.ts:39-49` (no password → pass; `auth_token` query accepted), `packages/axiomsec/src/cli/cmd/serve.ts:11-12` (warning only), `packages/axiomsec/src/cli/network.ts:11-15` (loopback default, overridable), `packages/axiomsec/src/mcp/oauth-callback.ts:187` (`listen(currentPort)` without host).
**Why it matters:** A `--hostname 0.0.0.0` server without a password is an unauthenticated remote control surface. The OAuth callback may listen on all interfaces despite a 127.0.0.1 redirect.
**Re-verify:** `sed -n '39,49p' packages/axiomsec/src/server/middleware.ts`; `sed -n '185,188p' packages/axiomsec/src/mcp/oauth-callback.ts`.
**Safe check:** Start on loopback only; curl with and without `AXIOMSEC_SERVER_PASSWORD`; do not expose the port.
**Fix direction:** Require a password (or a one-time token) for non-loopback binds, bind OAuth to 127.0.0.1, and drop `auth_token` from URLs.
**Related:** `SEC-07`, `V-S5`.

### RISK-PATH-01 — Path containment is lexical

**Status:** needs-verify · **Severity:** high · **Verified:** 2026-10-21 (code), impact not reproduced
**Evidence:** `packages/axiomsec/src/support/filesystem.ts:123-125` (`contains` uses `relative()`), `packages/axiomsec/src/project/instance.ts:94-102` (`containsPath` uses it); `packages/axiomsec/src/tools/external-directory.ts` checks the unresolved target.
**Why it matters:** A symlink or junction inside the workspace can point outside it; a lexical check would still consider it contained, bypassing the external-directory prompt.
**Re-verify:** `sed -n '123,125p' packages/axiomsec/src/support/filesystem.ts`; `sed -n '89,102p' packages/axiomsec/src/project/instance.ts`.
**Safe check:** In a disposable temp dir, create a symlink to another temp dir and call `contains`; no sensitive files.
**Fix direction:** Canonicalize with `realpath` before containment; handle Windows junctions and case-insensitivity.
**Related:** `ENG-06`, `V-S3`.

### RISK-PERSIST-02 — Operation slug collision can clobber state

**Status:** open · **Severity:** high · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/core/operation/operation.ts:182-187` (minute-precision suffix), `:355-362` (initial facts/ledger/relations written with `writeFile`), `:400-420` (`create` writes the operation dir).
**Why it matters:** Two operations with the same label in the same minute can resolve to the same slug. The second create overwrites the initial projections and upserts the same DB rows, losing the first operation’s initial state.
**Re-verify:** `sed -n '182,187p;355,362p;400,420p' packages/axiomsec/src/core/operation/operation.ts`.
**Safe check:** Create two same-label operations in a disposable workspace within one minute; inspect directories. Do not do this in a real workspace.
**Fix direction:** Use a collision-proof unique ID (ULID) or retry with a random suffix; fail if the directory exists.
**Related:** `ENG-02`, `V-S2`.

## Medium

### RISK-PERSIST-01 — Unlocked JSONL and manifest appends

**Status:** open · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/core/evidence/store.ts:89-102` (read manifest, then append; no lock), `packages/axiomsec/src/core/cyber/cyber.ts:489` (append to projection); the legacy operation store explicitly documents no multi-writer semantics (`packages/axiomsec/src/core/operation/store.ts:9-10`).
**Why it matters:** Two processes can append duplicate manifest entries or interleave JSONL lines; evidence reads may see a torn state.
**Re-verify:** `sed -n '89,102p' packages/axiomsec/src/core/evidence/store.ts`; `sed -n '485,492p' packages/axiomsec/src/core/cyber/cyber.ts`.
**Safe check:** Two concurrent writers against a disposable evidence store; inspect the manifest.
**Fix direction:** Use file locks (`Flock`/`effect-flock`) or a single SQLite manifest; make appends atomic.
**Related:** `ENG-02`, `SEC-04`, `V-S4`.

### RISK-PERSIST-03 — Migration failure is swallowed for the process lifetime

**Status:** open · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/core/operation/operation.ts:26-31` — the workspace is added to `migrated` before `migrate()` runs, and the error is discarded.
**Why it matters:** A transient failure leaves the workspace unmigrated with no retry until process restart; the UI may appear healthy while projections are missing.
**Re-verify:** `sed -n '26,32p' packages/axiomsec/src/core/operation/operation.ts`.
**Safe check:** Code read; for a runtime check, use a disposable workspace and an unwritable legacy path.
**Fix direction:** Mark after success, log the failure, and retry or surface a visible warning.
**Related:** `ENG-07`, `V-S2`.

### RISK-TIME-01 — Timeout gaps in network/subprocess paths

**Status:** needs-verify · **Severity:** medium · **Verified:** 2026-10-21 (SDK timeout=false), other paths code-read
**Evidence:** `packages/sdk/src/v2/client.ts:47-57` (`req.timeout = false`); `packages/axiomsec/src/npm/npm.ts:43` (unbounded `fetch`); `packages/axiomsec/src/installer/installation.ts:107,123,153` (spawns without timeout); `packages/axiomsec/src/tools/share.ts:84-97,190-198` (signing/tar without timeout); `packages/axiomsec/src/cli/cmd/replay.ts:126` (minisign spawn).
**Why it matters:** A hung registry, installer, signer, or tar can stall the agent loop indefinitely.
**Re-verify:** `sed -n '47,57p' packages/sdk/src/v2/client.ts`; `rg -n "fetch\\(|spawn\\(|spawnSync\\(" packages/axiomsec/src packages/sdk/src` and inspect each call for a signal/timeout.
**Safe check:** Static read only. Do not start a hanging request.
**Fix direction:** Add `AbortSignal.timeout`/`Effect.timeout` to every path; propagate a typed timeout error.
**Related:** `ENG-03`, `V-S8`.

### RISK-BUILD-01 — Hardcoded `/tmp` paths

**Status:** open · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/drizzle.config.ts:8` (`/tmp/axiomsec-dev.db`); `packages/axiomsec/src/cli/cmd/replay.ts:122` (`/tmp/axiomsec-sign-*.txt`).
**Why it matters:** Windows dev and CI can fail or write to an unexpected location; temp files can collide.
**Re-verify:** `sed -n '8p' packages/axiomsec/drizzle.config.ts`; `sed -n '120,130p' packages/axiomsec/src/cli/cmd/replay.ts`.
**Safe check:** Read the files. On Windows, use a disposable clone before running `db generate`.
**Fix direction:** Use `os.tmpdir()` and a unique suffix; honor `TMPDIR`/`TEMP`.
**Related:** `ENG-06`, `V-S8`.

### RISK-BUILD-02 — Generated artifacts can drift; SDK generator is missing

**Status:** open · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `packages/sdk/src/v2/gen/*` says generated; `packages/sdk/package.json:26-28` has only `typecheck`, no generate script; `packages/axiomsec/script/generate.ts` writes `packages/axiomsec/src/providers/models-snapshot.*`; `.gitignore:48` ignores the snapshot.
**Why it matters:** A route/schema change can leave the SDK stale; a fresh checkout may not regenerate the model snapshot reproducibly.
**Re-verify:** `sed -n '26,28p' packages/sdk/package.json`; `sed -n '10,20p' packages/axiomsec/script/generate.ts`.
**Safe check:** Read-only. Do not hand-edit `gen/*`.
**Fix direction:** Check in the OpenAPI generator config/script; make regeneration reproducible and document it.
**Related:** `ENG-05`, `CHANGE-PLAYBOOKS.md` §F, `V-S5`.

### RISK-BUILD-03 — Build failed resolving Playwright optional dependencies

**Status:** fixed 2026-10-21 (Release 0.2.0) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `bun run --cwd packages/axiomsec build --single --skip-install` failed on Windows while bundling `playwright-core` with “Could not resolve: `electron`” and “Could not resolve: `chromium-bidi/...`” under `node_modules/.bun/playwright-core@1.59.1`; reproduced with both Bun 1.3.11 and 1.4.3. Playwright is used by `packages/axiomsec/src/tools/browser.ts`.
**Why it matters:** The failure blocks the artifact build, startup smoke, GitHub release, and npm/Docker publish. `playwright-core` conditionally requires Electron/BiDi modules that are not in the lockfile.
**Fix:** `packages/axiomsec/script/build.ts` now externalizes `electron`, `chromium-bidi`, and `chromium-bidi/*` alongside `node-gyp`. The build and `--version` smoke pass with Bun 1.3.11 and 1.4.3.
**Re-verify:** `bun run --cwd packages/axiomsec build --single --skip-install`; confirm the binary prints a version. If the bundler starts resolving those optional paths again, reopen this risk.
**Safe check:** Local build only; do not publish or sign artifacts.
**Fix direction:** Keep optional Playwright paths external; do not add heavyweight Electron dependencies just to satisfy the bundler.
**Related:** `RISK-BUILD-01`, `RISK-BUILD-02`, `V-S8`.

### RISK-RELEASE-01 — Release test gate failed when no tests existed

**Status:** fixed 2026-10-21 (Release 0.2.0) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `.github/workflows/release.yml` originally ran `bun test --timeout 30000` unconditionally in `packages/axiomsec`; `bun test` exits 1 with “No tests found!” (verified with Bun 1.3.11); root `package.json:12` is a no-op; `.gitignore:35-47` ignores tests; `bunfig.toml:4-5` redirects the test root.
**Why it matters:** The release gate failed before any artifact or GitHub release could be produced, even though the lite repo intentionally ships no tests.
**Fix:** The workflow now runs `bun test` only when `*.test.*`/`*.spec.*` files exist; otherwise it prints a skip message. This keeps a real gate for future tests without failing on zero tests.
**Re-verify:** `sed -n '40,62p' .github/workflows/release.yml`; run `bun test --timeout 30000` in `packages/axiomsec` and confirm it still exits 1 when no tests exist (the workflow skips it). Do not run the release workflow.
**Safe check:** Read-only or a disposable test command.
**Fix direction:** Add real tests and remove the lite-repo caveat when the test harness exists.
**Related:** `RISK-CI-01`, `V-S8`, `VERIFICATION.md`.

### RISK-CI-02 — Clean-install typecheck failed on an undeclared `glob` dependency

**Status:** fixed 2026-10-21 (Release 0.2.0) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** The Release workflow failed at `bun typecheck` with `packages/shared/src/util/glob.ts(1,50): error TS2307: Cannot find module 'glob' or its corresponding type declarations.` Local Windows checks passed because `glob` was hoisted from `packages/axiomsec`.
**Why it matters:** A clean Linux install must not rely on a sibling package’s transitive dependency; the release failed before any artifact was built.
**Fix:** `packages/shared/package.json` now declares `"glob": "13.0.5"` and the lockfile workspace entry matches. `bun install --frozen-lockfile` and `bun turbo typecheck` pass.
**Re-verify:** `bun install --frozen-lockfile`; `bun turbo typecheck --force`; confirm `glob` is in `packages/shared/package.json` dependencies.
**Safe check:** Local verification only.
**Fix direction:** Declare every imported package in the package that imports it; do not rely on workspace hoisting.
**Related:** `RISK-CI-01`, `V-S8`.

### RISK-RELEASE-02 — Release referenced a missing postinstall script

**Status:** fixed 2026-10-21 (Release 0.2.0) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `.github/workflows/release.yml:203,245,270` referenced `packages/axiomsec/script/postinstall.mjs`; `ls packages/axiomsec/script` shows only `build.ts` and `generate.ts`.
**Why it matters:** The npm publish job would fail before publishing because the file was copied, required, and referenced by the meta package.
**Fix:** Removed the missing postinstall copy, meta-package script, and required-file check. The `bin/axiomsec` launcher resolves the platform binary from the installed optional dependency, so the install hook was redundant.
**Re-verify:** `rg -n "postinstall" .github/workflows/release.yml packages/axiomsec/bin/axiomsec`; confirm no missing-file reference remains.
**Safe check:** Read-only.
**Fix direction:** If a real postinstall behavior is needed later, restore the file and the publish checks together.
**Related:** `V-S8`.

## Low

### RISK-DOC-01 — README/CHANGELOG advertise `/initialize`; the command is `/init`

**Status:** open · **Severity:** low · **Verified:** 2026-10-21
**Evidence:** `README.md:100,171` and `CHANGELOG.md:44` describe `/initialize`; `packages/axiomsec/src/commands/command.ts:70` defines `INIT: "init"` and `:181-190` registers “guided AGENTS.md setup”; `packages/axiomsec/src/commands/template/initialize.txt:1` says “Create or update AGENTS.md”.
**Why it matters:** An agent following the README can run `/init` expecting an operation scaffold and instead rewrite the root `AGENTS.md` harness.
**Re-verify:** `sed -n '96,104p;166,175p' README.md`; `sed -n '40,48p' CHANGELOG.md`; `sed -n '69,71p;181,190p' packages/axiomsec/src/commands/command.ts`.
**Safe check:** Read-only. Do not run `/init` at repo root.
**Fix direction:** Correct the docs to `/init` (AGENTS.md) and `/pwn`/`operation new` for operations.
**Related:** `AGENTS.md` danger zone, `VERIFICATION.md`.

### RISK-DOC-02 — README tool list is a subset; registry keys differ from tool ids

**Status:** open · **Severity:** low · **Verified:** 2026-10-21
**Evidence:** `README.md:183-194` lists a marketing subset; `packages/axiomsec/src/tools/registry.ts:236-336` shows registry keys (`fetch`, `todo`, `search`, `code`, `patch`, `httprequest`) that differ from tool ids (`webfetch`, `todowrite`, `websearch`, `codesearch`, `apply_patch`, `http_request`); `question`/`plan` are conditional.
**Why it matters:** Agents grep for the wrong name or assume a tool is always visible.
**Re-verify:** `sed -n '183,194p' README.md`; `sed -n '236,336p' packages/axiomsec/src/tools/registry.ts`.
**Safe check:** Read-only.
**Fix direction:** Document the registry as the source of truth; list conditional tools explicitly.
**Related:** `ARCHITECTURE.md` §7.

### RISK-LINT-01 — Lint/format configuration is inconsistent

**Status:** open · **Severity:** low · **Verified:** 2026-10-21
**Evidence:** `.oxlintrc.json:3-5,44-49` has duplicate `options` keys; Prettier config at `package.json:101-104` is unenforced (no format script/CI); `.editorconfig:9` sets 80 columns while Prettier uses 120.
**Why it matters:** Agents can “fix” formatting in unrelated files or trust a lint pass that ignores formatting.
**Re-verify:** `sed -n '1,51p' .oxlintrc.json`; `sed -n '101,104p' package.json`; `sed -n '9p' .editorconfig`.
**Safe check:** Read-only; run `bun run lint` if needed.
**Fix direction:** Remove duplicate keys, wire a format check or document the absence, reconcile column width.
**Related:** `ENG-05`, `V-S8`.

### RISK-CI-01 — CI lacks tests, format, and security checks

**Status:** open · **Severity:** low · **Verified:** 2026-10-21
**Evidence:** `.github/workflows/ci.yml:18-45` runs typecheck, lint, and a single-platform build only.
**Why it matters:** Regressions in behavior, formatting, dependency risk, and platform compatibility can merge green.
**Re-verify:** `sed -n '18,45p' .github/workflows/ci.yml`.
**Safe check:** Read-only.
**Fix direction:** Add a real test job, format check, dependency audit, and an OS matrix when the test story exists.
**Related:** `VERIFICATION.md`, `RISK-RELEASE-01`.

## Leads (not verified)

These are suspicions from code reading, not confirmed facts. Do not cite them as bugs until reproduced.

- **Redirect scope re-checks** — `http_request` exposes `follow_redirects` but the parameter is not read (`packages/axiomsec/src/tools/http-request.ts`); if the HTTP client follows redirects, the final host may not be re-checked against the boundary. Confirm with a loopback redirect fixture.
- **Provider env writes** — provider auth appears to write credentials into `process.env` (`packages/axiomsec/src/providers/provider.ts` near the env-direct reads). Confirm whether secrets can leak to child processes or logs.
- **Swallowed projection failures** — `packages/axiomsec/src/core/cyber/cyber.ts` and `packages/axiomsec/src/core/operation/operation.ts` use best-effort catches around JSONL/projection writes. Confirm whether a failure can leave DB and projections inconsistent without a warning.
- **No operation HTTP API** — the route tree has no operation/scope/finding endpoints (`packages/axiomsec/src/server/instance/index.ts:34-105`). Confirm no SDK client assumes them; if a client does, it will 404.

## Re-verify protocol

1. Re-read the cited lines. Update the date only when you actually checked.
2. Prefer a read-only `sed`/`rg` command plus, where safe, a disposable loopback reproduction.
3. If fixed: keep the entry, mark `fixed YYYY-MM-DD`, add the commit/PR, and leave the evidence.
4. If unverifiable: mark `stale`, keep the evidence, and add a task to re-check.
5. New risk: use the entry template, cite at least one exact line, and include a safe re-verify command.
6. Never add a risk without a safe way to confirm it. Never use real credentials, customer data, or third-party targets.

Next: [INVARIANTS.md](INVARIANTS.md) for the rules, [BUG-HUNTING.md](BUG-HUNTING.md) for audit actions, [VERIFICATION.md](VERIFICATION.md) for proof, [ARCHITECTURE.md](ARCHITECTURE.md) for mechanisms.
