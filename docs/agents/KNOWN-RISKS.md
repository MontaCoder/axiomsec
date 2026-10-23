# AxiomSec Known Risks

> **Dated register.** Baseline: commit `d1a6a18`, verified 2026-10-21. Line numbers are anchors, not truth. Re-read every cited line before relying on it. If code moved, update the citation and date in the same change. If you cannot verify an entry, mark it `stale`; do not silently trust it.

This register documents risks; it does not fix them unless an entry is marked `fixed`. It makes risks visible so future agents do not rediscover them the hard way.

## Legend

- **Severity:** `critical` — silent scope/permission/proof bypass or secret leak; `high` — cross-session leakage, auth exposure, data loss, or false verification with modest effort; `medium` — reliability/platform/dependency gap with a workaround; `low` — docs/tooling drift that wastes agent time.
- **Status:** `open` (verified, unresolved), `needs-verify` (code-read but impact not reproduced), `accepted` (known tradeoff), `fixed` (with date/commit), `stale` (cannot re-verify).
- **Safe checks only:** loopback fixtures, disposable workspaces, canary strings. No third-party targets, no real credentials, no exploit payloads.

## Critical

### RISK-SCOPE-01 — Guard is per-tool, not a runtime choke point

**Status:** fixed 2026-10-21 for `browser`/`net` (the model remains per-tool; `bash` is tracked as `RISK-SCOPE-03`) · **Severity:** critical · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/core/boundary/guard.ts:87-118`; call sites in `packages/axiomsec/src/tools/http-request.ts:74`, `packages/axiomsec/src/tools/webfetch.ts:43`, `packages/axiomsec/src/tools/scanner.ts:578`, `packages/axiomsec/src/tools/appsec-probe.ts:649`; no Guard import in `packages/axiomsec/src/tools/browser.ts`, `packages/axiomsec/src/tools/net.ts`, or `packages/axiomsec/src/tools/bash.ts`.
**Progress 2026-10-21:** `browser` now checks an explicit URL before `ctx.ask` (`packages/axiomsec/src/tools/browser.ts:953-960`) and installs a context-level request route that aborts every HTTP(S) request whose boundary decision is not `allow` (`browser.ts:233-247`). `net` checks the host before asking or connecting (`packages/axiomsec/src/tools/net.ts:113-121`). Verified with strict scope on loopback: an in-scope page loaded while its `127.0.0.2` subresource never reached the tracker; an explicit `127.0.0.2` navigation was denied; an in-scope banner grab completed; a `127.0.0.2` TCP attempt was denied before connect.
**Remaining:** `bash` still has no boundary check; arbitrary commands can egress. See `RISK-SCOPE-03`.
**Why it matters:** A new or remaining egress path can bypass the active operation’s boundary entirely. `bash` can reach anything the process can.
**Re-verify:** `rg -n "Guard\\.(check|checkUrl|checkHost|checkPath)" packages/axiomsec/src/tools` and `rg -n "fetch\\(|spawn\\(|Bun\\.spawn|playwright|net\\.connect" packages/axiomsec/src/tools`.
**Safe check:** Disposable loopback fixtures only; the browser check needs a local page plus a second loopback host and Chromium (`AXIOMSEC_CHROMIUM_PATH` if the Playwright revision is missing).
**Fix direction:** Move Guard invocation into a shared execution choke point for target-touching tools, or require every such tool to call it and add a static check.
**Related:** `SEC-01`, `SEC-02`, `RISK-SCOPE-02`, `RISK-SCOPE-03`, `V-S3`.

### RISK-SCOPE-03 — `bash` can egress without a boundary decision

**Status:** accepted (ask-by-default mitigation; no boundary enforcement) · **Severity:** high · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/tools/bash.ts` imports no `Guard`; `BashTool.ask` scans command patterns and external directories (`bash.ts:262-282`) but never checks the operation boundary. A command can resolve DNS or open sockets to any host.
**Why it matters:** One unguarded shell path defeats the boundary for any target the process can reach, including third-party hosts and internal networks.
**Mitigation:** `bash` now resolves to `ask` by default (`agent.ts:113`), so an operation-attached shell command prompts; non-interactive `run` auto-rejects asks unless `--dangerously-skip-permissions` is used (`RISK-PERM-03`). An operator who approves a command can still egress anywhere.
**Re-verify:** `rg -n "Guard" packages/axiomsec/src/tools/bash.ts` (expect no matches); inspect the `ask` function and the default rule.
**Safe check:** Read-only; do not use an unguarded shell against a real target.
**Fix direction:** Enforce scope in a shared execution choke point (sandbox/proxy/network namespace). Do not rely on scraping URLs out of arbitrary commands.
**Related:** `RISK-SCOPE-01`, `RISK-SCOPE-02`, `RISK-PERM-01`, `RISK-PERM-03`, `V-S3`.

### RISK-SCOPE-04 — Scheme scope patterns matched by raw string prefix

**Status:** fixed 2026-10-22 · **Severity:** critical · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/boundary/evaluate.ts:18` returned `u.origin === pattern || req.value.startsWith(pattern)`. With `in_scope: ["https://example.com"]`, both `https://example.com.evil.test/` and `https://example.com@evil.test/` returned `allow` because the raw URL started with the allowed origin string.
**Why it matters:** Any operator or migrated notebook scope using a scheme-qualified pattern could be bypassed by a hostname that merely starts with the allowed origin, defeating the boundary before any tool-level check.
**Fix:** `evaluate.ts:13-40` parses the pattern, compares protocol, hostname (including `*.` wildcards), and effective port, then applies path-prefix or path-glob matching. The raw `startsWith` check is gone.
**Reproduction (post-fix):** `evaluate({ default: "ask", in_scope: ["https://example.com"] }, { kind: "url", value: "https://example.com.evil.test/" })` returns `ask`; exact origin and path-prefix cases still return `allow`.
**Re-verify:** `VERIFICATION.md` §V-S12.
**Related:** `SEC-01`, `SEC-02`, `RISK-SCOPE-01`, `V-S12`.

### RISK-SCOPE-05 — Redirects and discovered subresources bypassed scope

**Status:** fixed 2026-10-22 · **Severity:** critical · **Verified:** 2026-10-22
**Evidence (pre-fix):** `http_request` and `webfetch` checked only the initial URL, then used `FetchHttpClient`'s automatic redirects. `scanner`'s `crawl`/`js-analyzer` used bare `fetch`, and sitemap URLs were queued without a boundary check. End-to-end with strict opsec and `in_scope: ["127.0.0.1"]`: `http_request http://127.0.0.1:19081/start` followed a 302 to `http://127.0.0.2:19183/landed` and returned `OUT-OF-SCOPE-HIT`; a crawl of the same target reached 127.0.0.2.
**Why it matters:** An in-scope URL that redirects, or a target that references external scripts/sitemaps, turns every guarded tool into an unguarded egress path. This is the redirect re-check lead that was previously unverified.
**Fix:** `packages/axiomsec/src/tools/guarded-http.ts:1-79` sets `redirect: "manual"`, checks every hop with `Guard.checkUrl`, requests the separate `scope` permission on `ask`, and strips credentials on cross-origin hops; `http-request.ts:110-120` and `webfetch.ts:93-103` use it. `packages/axiomsec/src/scanners/http.ts` adds `fetchGuarded`; `crawl.ts:170-215`, `js-analyzer.ts:137-166`, and `scanner.ts:602-622` pass an `allowUrl` callback that permits explicitly in-scope URLs and the operator-approved target's origin and path subtree.
**Reproduction (post-fix):** with strict opsec and a loopback 302 fixture, `http_request` and `webfetch` exit 1 with `out of scope: url=http://127.0.0.2:19183/landed` and the out-of-scope fixture receives no request; the in-scope crawl control still lists its page.
**Residual:** redirects are capped at 10 (`http_request`/`webfetch`) and 5 (scanner); scanner subresources that resolve to boundary `ask` are skipped rather than prompted, matching the browser route behavior.
**Re-verify:** `VERIFICATION.md` §V-S12; loopback fixtures only.
**Related:** `SEC-01`, `SEC-02`, `RISK-SCOPE-01`, `RISK-NET-01`, `V-S3`, `V-S12`.

### RISK-SCOPE-06 — Browser WebSockets escaped the HTTP route guard

**Status:** fixed 2026-10-22 · **Severity:** critical · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/tools/browser.ts` installed `context.route("**/*")`, which covers HTTP(S) but not WebSocket handshakes. A page loaded from `127.0.0.1` opened `ws://127.0.0.2:19184`; the out-of-scope fixture logged `WS-HIT OUT-OF-SCOPE-WS`.
**Why it matters:** A target page could exfiltrate data over a socket even while every HTTP request and navigation was boundary-checked.
**Fix:** `browser.ts:256-269` installs `context.routeWebSocket` for every socket URL, calls `connectToServer()` only when `Guard.checkUrl` returns `allow`, and closes with code 1008 otherwise.
**Reproduction (post-fix):** with a clean loopback WebSocket fixture, the navigation succeeds but the fixture logs only its startup line (no `WS-OPEN`/`WS-HIT`).
**Residual:** WebRTC data channels, DNS prefetch/preconnect, and other non-HTTP browser mechanisms are not intercepted; see the lead below.
**Re-verify:** `VERIFICATION.md` §V-S12; loopback fixtures and Chromium only.
**Related:** `SEC-01`, `SEC-02`, `RISK-NET-01`, `V-S12`.

### RISK-SCOPE-02 — Boundary `ask` is not an independent approval

**Status:** fixed 2026-10-21 · **Severity:** critical · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/core/boundary/guard.ts:89` (no active op → allow), `:103-117` (`ask` returned, only `deny` threw); callers recorded `scope.mode` and called their own `ctx.ask`, which the permission rules could resolve to allow.
**Why it matters:** A request outside `in_scope` but not explicitly `out_of_scope` yields `ask`. If the tool permission was allowed, the boundary `ask` never became a human decision, and an auto-approving caller could execute without one.
**Fix:** `packages/axiomsec/src/core/boundary/guard.ts:132-145` adds `approvalRequest`. The Guarded egress tools now issue a separate `scope` ask whenever the boundary returns `ask`: `http_request.ts:79-81`, `webfetch.ts:47-49`, `scanner.ts:585-587`, `appsec-probe.ts:652-654`, `net.ts:119-121`, `browser.ts:961-963`. `agent.ts:124` defaults `scope` to `ask`.
**Reproduction:** with opsec normal and only `127.0.0.1` in scope, `net`, `http_request`, and `browser` to `127.0.0.2` all refused without `--dangerously-skip-permissions` with “permission 'scope' resolves to ask”; in-scope `net` skipped the scope ask and only requested `net`.
**Residual:** an operator can explicitly configure `scope: allow` (that is an informed override); browser subresource requests that resolve to `ask` are aborted by the route guard rather than prompted; `bash` remains outside the boundary (`RISK-SCOPE-03`).
**Re-verify:** `VERIFICATION.md` §V-S3.
**Related:** `SEC-01`, `SEC-03`, `RISK-PERM-01`, `RISK-SCOPE-01`, `RISK-SCOPE-03`, `V-S3`.

### RISK-PERM-01 — Built-in permission defaults are allow-all

**Status:** fixed 2026-10-21 (network/shell/secret classes) · **Severity:** critical · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/agent/agent.ts:110-127` (`"*": "allow"`), explicit asks only for `http_request`/`browser`; `packages/axiomsec/src/permissions/evaluate.ts:9-15` (last match, default `ask` only when no rule matches); `packages/axiomsec/src/tools/vault.ts:59-74` (reveal without ask); `packages/axiomsec/src/tools/scanner.ts:585-596`, `packages/axiomsec/src/tools/net.ts:111-112`, `packages/axiomsec/src/tools/bash.ts:267-277` (asks whose default rule was allow).
**Why it matters:** Most built-in tools executed without a prompt under the default agent configuration, including network, shell, and secret access.
**Fix:** `packages/axiomsec/src/agent/agent.ts:110-127` now defaults `bash`, `net`, `scanner`, `http_request`, `browser`, `webfetch`, `websearch`, `appsec_probe`, `vault`, `identity`, `share`, and `scope` to `ask`; last-match evaluation makes those asks win. Verified with the `security` agent: `vault set`, `bash`, `net`, and `http_request` refuse without `--dangerously-skip-permissions` and run with it; `scope` still runs without the flag. The read-only `explore` agent keeps explicit allows.
**Residual:** non-network/non-secret tools (notably `edit`/`write`/`read` except `.env`, task/play/runbook) still resolve to `"*": "allow"`; this is tracked as `RISK-PERM-04`. User config can override any ask.
**Re-verify:** `sed -n '110,132p' packages/axiomsec/src/agent/agent.ts`; run a sensitive tool with `debug agent` with and without the flag (`VERIFICATION.md` §V-S3).
**Safe check:** Disposable workspace and canaries only.
**Related:** `SEC-03`, `RISK-SCOPE-02`, `RISK-PERM-02`, `RISK-PERM-03`, `RISK-PERM-04`, `V-S3`.

### RISK-PROOF-01 — Finding promotion trusts arbitrary evidence refs

**Status:** fixed 2026-10-21 · **Severity:** critical · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/tools/finding.ts:24-36` (`evidence: string[]`), `:245-309` (refs accepted, only length checked), `packages/axiomsec/src/core/cyber/oracle.ts:77-83` (non-empty refs satisfy the evidence gate), `packages/axiomsec/src/core/cyber/finding.ts:189-194` (reportable predicate).
**Why it matters:** A finding could be promoted as `verified`/reportable with fabricated 64-hex strings and a replay string, because the oracle did not resolve the refs to evidence files or compare hashes. That defeats the proof-first design.
**Fix:** `packages/axiomsec/src/core/evidence/store.ts:65-72` adds `verify`, which resolves the manifest entry and re-hashes the stored bytes against the requested digest. `packages/axiomsec/src/tools/finding.ts:266-283` verifies every supplied and inherited evidence ref before the replay artifact is written or the oracle runs, rejecting promotion with `unresolved_evidence` when any ref is unknown or corrupt.
**Reproduction (pre-fix):** promoting `fabricated-finding` with a fabricated `aaaa…` ref returned `status: verified`, `oracle: passed`.
**Re-verify:** run the negative/positive/tamper cases in `VERIFICATION.md` §V-S4. A fabricated ref must be rejected and `finding status` must report `found: false`; a real ref must promote; a tampered artifact must be rejected.
**Related:** `SEC-04`, `SEC-05`, `V-S4`.

### RISK-SECRET-01 — Share redaction is narrow

**Status:** fixed 2026-10-21 · **Severity:** critical · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/tools/share.ts:41` (`REDACT_EXTS` was only `.md`, `.txt`, `.json`, `.log`, `.yml`, `.yaml`, `.csv`), `:54-60` (applied `redactString`), `:141-168` (copied evidence/cyber/workflow/context and redacted staged files); `packages/axiomsec/src/core/replay/redact.ts:13-20` (JWT-only string redaction); `packages/axiomsec/src/tools/http-request.ts:159-196` (evidence stores merged headers, cookies, body).
**Why it matters:** A share bundle could include `.jsonl` ledger/fact projections, `.har`/`.html` evidence, and JSON containing Authorization/Cookie/API-key values. Redaction removed JWTs and selected text, not structure-aware secrets.
**Fix:** `packages/axiomsec/src/core/replay/redact.ts:13-70` now redacts JWTs, Authorization/Proxy-Authorization/Cookie/Set-Cookie headers, quoted and unquoted secret assignments, and header-pair objects (`{name,value}`) such as HAR headers. `packages/axiomsec/src/tools/share.ts:41-99` parses JSON/JSONL/HAR/NDJSON and applies `redactValue`; the text extension set now includes JSONL, HAR, HTML, XML, and TSV. `share.ts:215-216` redacts the entire staged tree before hashing.
**Residual:** binary artifacts, extensionless files, positional CSV values, and bare opaque strings with no key/header pattern are not content-scanned (`RISK-SECRET-03`); tool args and agent output are still ledgered (`RISK-SECRET-02`, fixed for structured secrets), so never put real credentials in a disposable-proof workflow.
**Reproduction:** canaries in text (`Authorization`, `Cookie`, `api_key`) and JSON (HAR header, `api_key`, nested `password`) survived pre-fix. Post-fix `tar -xOzf` found zero canaries, the redacted JSON stayed parseable, and all bundle manifest hashes matched.
**Re-verify:** `VERIFICATION.md` §V-S6; build with `redact:true`, then `redact:false` as a control.
**Related:** `SEC-06`, `RISK-SECRET-02`, `V-S6`.

### RISK-PROOF-03 — A finding could self-certify with its own replay text

**Status:** fixed 2026-10-22 · **Severity:** critical · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/tools/finding.ts` stored the model-authored `replay` string as an evidence artifact and pushed its SHA into the *same* `evidenceRefs` array that satisfied the evidence gate; `replay_present: Boolean(replayRef)` then satisfied the replay half. `packages/axiomsec/src/core/cyber/oracle.ts:77-83` is `evidence_present && (replay_present || exemption_valid)`, so one model sentence satisfied both halves of the AND.
**Why it matters:** the proof-first design collapsed. The agent could promote a fabricated claim to `status: verified` / `oracle: passed` and into the reportable bucket of `report.md` with no artifact of its own.
**Fix:** the replay artifact is tracked separately (`replay_ref`, a `replay_bundle` fact, a `backed_by → replay_artifact` relation) and is never part of `evidence_refs`. Promotion requires at least one independently supplied ref that resolves through `Evidence.verify`, and then asks for approval.
**Reproduction (pre-fix):** `axiomsec debug agent security --tool finding --params '{"action":"promote","key":"self-certified","replay":"trust me"}'` returned `status: verified`, `oracle: passed`, `evidence: <sha of "trust me">`. Post-fix the same call returns `Promotion requires at least one evidence reference …`, `promoted: false`, and `finding status` reports `found: false`.
**Re-verify:** `VERIFICATION.md` `V-S13`; `packages/axiomsec/test/core/cyber/finding.test.ts`.
**Related:** `SEC-05`, `RISK-PROOF-01`, `RISK-PROOF-04`, `V-S4`, `V-S13`.

### RISK-SCOPE-07 — A model-supplied operation slug escaped the operation tree

**Status:** fixed 2026-10-22 · **Severity:** critical · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/operation/operation.ts` `opDir()` = `path.join(rootDir(workspace), slug)` with no validation; `packages/axiomsec/src/tools/tool.ts` `resolveOperationSlug` returned an explicit slug verbatim; `packages/axiomsec/src/tools/workspace.ts` passed the model's own `params.slug` (`z.string().optional()`) straight through; `packages/axiomsec/src/core/evidence/store.ts` `evidenceDir` + `mkdir(recursive)` created trees outside `.axiomsec/operation/`.
**Why it matters:** a tool argument could redirect evidence, ledger and fact writes to any directory the process could write to, escaping the operation sandbox and the audit boundary.
**Fix:** `packages/axiomsec/src/core/operation/slug.ts` holds the slug rules (`isValidSlug`, `containedPath`). `opDir`, `Evidence.evidenceDir` and `Deliverable.build` assert containment; `Operation.read`/`activate`/`activeSlug` reject malformed slugs; `resolveOperationSlug` and `explicitOperationSlug` filter them; the `workspace` tool reports an invalid slug instead of acting on it.
**Reproduction (pre-fix):** `axiomsec debug agent security --tool workspace --params '{"action":"rename","slug":"../..","label":"TRAVERSAL-CANARY"}'` wrote `<workspace>/cyber/ledger.jsonl` and `<workspace>/cyber/facts.jsonl` and reported success. Post-fix it returns `Invalid operation slug: "../.."` and creates nothing outside `.axiomsec/operation/`.
**Re-verify:** `VERIFICATION.md` `V-S13`; `packages/axiomsec/test/core/operation/slug.test.ts`.
**Related:** `SEC-01`, `SEC-02`, `RISK-SCOPE-01`, `RISK-PATH-01`, `V-S13`.

## High

### RISK-PERM-02 — `debug agent` turns `ask` into allow

**Status:** fixed 2026-10-21 · **Severity:** high · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/cli/cmd/debug/agent.ts:181-190` — the synthetic context’s `ask` threw only for an explicit `deny`; `allow` and `ask` both proceeded silently.
**Why it matters:** It is a useful tool smoke-test, but dangerous on a real workspace or target: the operator saw no prompt and no warning.
**Fix:** `packages/axiomsec/src/cli/cmd/debug/agent.ts:35-38,190-200` adds `--dangerously-skip-permissions`. Ask-level tools now fail closed with an explanatory error unless the flag is passed; with the flag, every bypass is printed to stderr.
**Reproduction:** post-fix, `debug agent security --tool http_request` against a loopback fixture exited 1 with “resolves to ask; re-run with --dangerously-skip-permissions”; with the flag it printed the bypass line and returned HTTP 200. A non-ask tool (`scope`) still ran without the flag.
**Re-verify:** repeat the two commands in `VERIFICATION.md` §V-S3.
**Safe check:** Disposable loopback workspace only; the flag is not a production permission.
**Fix direction:** Keep the flag test-only; do not wire it into normal sessions.
**Related:** `SEC-03`, `RISK-PERM-01`, `RISK-PERM-03`, `V-S3`.

### RISK-PERM-03 — `run --dangerously-skip-permissions` auto-approves

**Status:** accepted (banner added 2026-10-21) · **Severity:** high · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/cli/cmd/run.ts:544-548` replies `once` to every `permission.asked`; without the flag it auto-rejects (`:549-558`).
**Why it matters:** A non-interactive run with this flag can execute any side-effecting tool the model chooses, subject only to explicit deny rules and Guard coverage.
**Mitigation:** `packages/axiomsec/src/cli/cmd/run.ts:412-420` prints a prominent stderr banner before the session loop when the flag is set. The flag remains intentionally dangerous and is documented in `AGENTS.md`.
**Re-verify:** `sed -n '535,560p' packages/axiomsec/src/cli/cmd/run.ts`; inspect the banner at `:412-420`.
**Safe check:** Read-only inspection; do not run it against a real workspace.
**Fix direction:** If stronger containment is required, require an additional environment opt-in or a disposable-workspace marker.
**Related:** `SEC-03`, `RISK-PERM-01`, `V-S3`.

### RISK-TOOL-02 — Tool wrapper validated arguments but executed raw ones

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/tools/tool.ts:252-263` called `toolInfo.parameters.parse(args)` only for validation and discarded the result, then executed the raw `args`. Zod `.default()` and `.coerce()` values were never applied.
**Why it matters:** Tool behavior depended on the model sending every field. `finding` with only `{ "key": "x" }` skipped the documented `action: "list"` default and fell through to the promotion branch; `http_request` without `method` built `curl -X undefined`; `evidence` without `action` could not list.
**Fix:** `tool.ts:252-278` binds `validatedArgs` and uses it for the ledger, workflow trace, and `execute`; the parsed value now reaches the tool.
**Reproduction (post-fix):** `debug agent security --tool finding --params '{"key":"defaults-probe"}'` returns `action: list`, title `finding · 0`, and does not attempt promotion.
**Re-verify:** `VERIFICATION.md` §V-S12.
**Related:** `ENG-04`, `RISK-TOOL-01`, `V-S3`, `V-S12`.

### RISK-PERM-05 — `evidence add_file` bypassed read and external-directory checks

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/tools/evidence.ts` passed `params.path` directly to `Evidence.put` with no `ctx.ask`, no external-directory check, and no `.env` read rule; `evidence` also resolved to `"*": "allow"`. A model could copy `.env` or any absolute path into immutable evidence, which reports and share bundles then expose.
**Why it matters:** The read tool protects `.env` and outside-workspace paths; evidence was a quieter path around both protections.
**Fix:** `evidence.ts:246-257` resolves the path against the workspace, calls `assertExternalDirectoryEffect`, then asks the `read` permission (the `.env` rules apply) before `Evidence.put`. `binary-triage.ts:90-100` and `iac-triage.ts:98-109` received the same external-directory plus `read` gate because they also accept user paths.
**Reproduction (post-fix):** `debug agent security --tool evidence --params '{"action":"add_file","path":".env"}'` exits 1 with `permission 'read' resolves to ask`; with `--dangerously-skip-permissions` it prints the bypass and stores the artifact.
**Residual:** `cloud_posture` and `container_surface` may read provider/container configuration outside the workspace without an equivalent gate; see the lead below.
**Re-verify:** `VERIFICATION.md` §V-S12; canary `.env` only.
**Related:** `SEC-03`, `SEC-06`, `RISK-PERM-04`, `V-S12`.

### RISK-PERM-06 — `interact` spawned and egressed without a permission request

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/tools/interact.ts` called no `ctx.ask`; `interact` was not in the sensitive default set (`packages/axiomsec/src/agent/agent.ts:110-127`), so `generate` could start `interactsh-client` and `close` could kill a recorded PID without a prompt.
**Why it matters:** A tool that starts a third-party network process or terminates one is a side effect under `SEC-03`; the human control was absent.
**Fix:** `interact.ts:90-97` asks the `interact` permission for the requested op, and `agent.ts:121` defaults `interact` to `ask`.
**Reproduction (post-fix):** `debug agent hacking --tool interact --params '{"op":"poll","id":"none"}'` exits 1 with `permission 'interact' resolves to ask`; with the test-only bypass it proceeds to the unknown-session error.
**Residual:** the interactsh host is tooling egress, not target traffic, and is not checked against the operation boundary or the strict opsec blocklist.
**Re-verify:** `VERIFICATION.md` §V-S3/V-S12; do not install or run interactsh against a real target.
**Related:** `SEC-03`, `RISK-SCOPE-03`, `RISK-PERM-01`, `V-S12`.

### RISK-TIME-02 — Triage subprocesses had no timeout

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/tools/process.ts:3-11` used a bare `Bun.spawn` with no timeout; `binary_triage`, `iac_triage`, `cloud_posture`, and `container_surface` all call it, so a hung adapter stalled the agent loop indefinitely.
**Why it matters:** A missing adapter process, credential prompt, or network hang could consume the session with no recovery.
**Fix:** `process.ts:3-16` passes `Bun.spawn`'s `timeout` option (10 minutes by default, overridable) and returns `timedOut` in the result.
**Reproduction (post-fix):** spawning `bun -e 'await Bun.sleep(5000)'` with `timeoutMs: 300` returns in ~307ms with `timedOut: true`.
**Residual:** the 10-minute bound is process-wide for these adapters; a future long-running scanner should pass an explicit value rather than removing the bound.
**Re-verify:** `VERIFICATION.md` §V-S12.
**Related:** `ENG-03`, `RISK-TIME-01`, `V-S12`.

### RISK-PROOF-02 — Replay signatures are produced but not verified

**Status:** fixed 2026-10-21 · **Severity:** high · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/cli/cmd/replay.ts:93-113` — `verify` checked `sha256_body`; if signed, it printed “verification not yet implemented”.
**Why it matters:** A signature in a replay trailer created false assurance. Integrity was body-hash only; provenance was not established.
**Fix:** `packages/axiomsec/src/cli/cmd/replay.ts:130-167` verifies minisign and cosign signatures when the corresponding public key is configured (`AXIOMSEC_MINISIGN_PUBKEY`, `COSIGN_PUBKEY`) and the tool is on PATH. Signed but unverifiable replays now print `UNVERIFIED` and exit 1; `show` labels the signature state. Unsigned replays still exit 0.
**Reproduction:** a synthetic signed trailer without a configured key returns exit 1 with “set AXIOMSEC_MINISIGN_PUBKEY”; the unsigned replay returns exit 0 with `signature: none`.
**Residual:** verification requires an operator-provided public key; `public_key_id` is not cross-checked; cosign verification is key-based with tlog verification disabled (`--insecure-ignore-tlog=true`).
**Re-verify:** `VERIFICATION.md` §V-S7.
**Related:** `SEC-05`, `V-S7`.

### RISK-SECRET-02 — Tool args are ledgered; vault reveal is ungated

**Status:** fixed 2026-10-21 · **Severity:** high · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/tools/tool.ts:247-259` (`tool.called` data included raw `input: args`); `packages/axiomsec/src/tools/vault.ts:59-74` (`get --reveal` returned the value with no `ctx.ask`), `:38-56` (`set` wrote the value); `packages/axiomsec/src/core/vault.ts:45-49` (plaintext JSON, 0600).
**Progress 2026-10-21:** `packages/axiomsec/src/tools/tool.ts:108-121,274` now applies structured `redactValue` plus per-tool secret fields (`vault`/`identity` `value`) before writing `tool.called` and workflow `last_args`. `vault.ts:41,71,103,162` asks before set, reveal, delete, and use_as; `identity.ts:94,150,206` asks before add, use, and clear; both permissions default to `ask` (`agent.ts:121-122`). Verified with canaries: `vault set` / `get --reveal` / `identity add` still work, the ledger contains zero canary occurrences, and inputs read `[redacted:secret:value]`.
**Residual:** request bodies, `net` payloads, and arbitrary nested values are not structurally redacted; revealed output remains in the session transcript by design; the vault is plaintext JSON at 0600. These are tracked as `RISK-SECRET-03`.
**Re-verify:** `rg -n "redactToolInput|permission: \"vault\"|permission: \"identity\"" packages/axiomsec/src/tools/{tool,vault,identity}.ts`; in a disposable operation set a canary vault value and grep the ledger.
**Safe check:** Canary values only; never store real credentials.
**Related:** `SEC-03`, `SEC-06`, `RISK-SECRET-01`, `RISK-SECRET-03`, `RISK-PERM-01`, `V-S3`, `V-S4`.

### RISK-NET-01 — Browser state is global and TLS errors are ignored

**Status:** fixed 2026-10-21 · **Severity:** high · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/tools/browser.ts:80-81` (module-level `sessions` Map + counter), `:137-140` (`ensure` reused one session), `:220` (`ignoreHTTPSErrors: true`).
**Why it matters:** Cookies/localStorage/headers/console buffers could persist across sessions and operations; unconditional TLS bypass made a MITM invisible.
**Fix:** `packages/axiomsec/src/tools/browser.ts:143-149` keys sessions by workspace, operation slug, and TLS mode, and closes every session with a different key. `:53` adds `ignore_https_errors` (default false), `:230` applies it to `newContext`, and `:692-693` builds the session key from the active boundary.
**Reproduction:** a self-signed loopback HTTPS page fails with `ERR_CERT_AUTHORITY_INVALID` by default and loads with `ignore_https_errors: true`. Cross-operation session reuse is prevented by the key/close path; it was code-verified, not exercised in one long-lived process.
**Residual:** the session registry is still a process-level Map (one active browser per operation, closed on switch) rather than `InstanceState`; browser requests that resolve to boundary `ask` are aborted rather than prompted.
**Re-verify:** `VERIFICATION.md` §V-S3 TLS check; inspect the session key and close loop.
**Related:** `ENG-01`, `SEC-01`, `RISK-NET-02`, `V-S3`.

### RISK-NET-02 — Server auth is optional; OAuth callback binds all interfaces

**Status:** fixed 2026-10-21 · **Severity:** high · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/server/middleware.ts:39-49` (no password → pass), `packages/axiomsec/src/cli/cmd/serve.ts:11-12` (warning only), `packages/axiomsec/src/cli/network.ts:11-15` (loopback default, overridable), `packages/axiomsec/src/mcp/oauth-callback.ts:187` (`listen(currentPort)` without host).
**Why it matters:** A `--hostname 0.0.0.0` server without a password was an unauthenticated remote control surface. The OAuth callback could listen on all interfaces despite a 127.0.0.1 redirect.
**Fix:** `packages/axiomsec/src/cli/cmd/serve.ts:11-18,29-33` refuses any non-loopback bind without `AXIOMSEC_SERVER_PASSWORD` before listening; loopback without a password still warns. `packages/axiomsec/src/mcp/oauth-callback.ts:187` binds the callback explicitly to `127.0.0.1`.
**Reproduction:** post-fix, `serve --hostname 0.0.0.0` without a password exits 1 with a clear error and no port opens; `serve --hostname 127.0.0.1` without a password prints the warning and returns 200; with a password, unauthenticated requests return 401.
**Residual:** loopback without a password remains reachable by local processes; this is a deliberate warning, not an auth boundary. Tokens in URLs are tracked separately (`RISK-NET-03`).
**Re-verify:** `VERIFICATION.md` §V-S5.
**Related:** `SEC-07`, `RISK-NET-03`, `V-S5`.

### RISK-PATH-01 — Path containment is lexical

**Status:** fixed 2026-10-21 · **Severity:** high · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/support/filesystem.ts:123-125` (`contains` used `relative()` lexically), `packages/shared/src/filesystem.ts:227-231` (same check on the `Instance.containsPath` path), `packages/axiomsec/src/project/instance.ts:94-102`, and `packages/axiomsec/src/tools/external-directory.ts` checked the unresolved target.
**Why it matters:** A symlink or junction inside the workspace could point outside it; the lexical check still reported it as contained, bypassing the external-directory prompt.
**Fix:** `packages/shared/src/filesystem.ts:227-247` and `packages/axiomsec/src/support/filesystem.ts:123-143` canonicalize both paths with `realpathSync.native` before `relative()`, resolving the nearest existing ancestor for paths that do not exist yet. Containment now rejects `..`, `..<sep>`, different drives, and symlink/junction escapes.
**Reproduction:** pre-fix, `contains(parent, parent/link/secret.txt)` returned true for a junction to an outside directory. Post-fix: inside=true, outside=false, junction escape=false, nonexistent-child=true, sibling-prefix=false, self=true.
**Re-verify:** `VERIFICATION.md` §V-S9.
**Related:** `ENG-06`, `RISK-BUILD-01`, `V-S3`.

### RISK-PERSIST-02 — Operation slug collision can clobber state

**Status:** fixed 2026-10-21 · **Severity:** high · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/core/operation/operation.ts:182-187` (minute-precision suffix after a non-atomic `existsSync` check), `:355-362` (initial facts/ledger/relations written with `writeFile`), `:400-420` (`create` wrote into the resolved directory).
**Why it matters:** Repeated or concurrent creates with the same label could resolve to the same slug; later writes overwrite the initial projections and upsert the same DB rows, losing the earlier operation’s initial state.
**Fix:** `packages/axiomsec/src/core/operation/operation.ts:182-207` now reserves a slug with an atomic non-recursive `mkdir`, trying the base slug, a minute-stamped slug, then random suffixes; it fails after 100 collisions. `create` uses the reserved directory (`operation.ts:427`). The legacy store uses the same atomic reservation (`store.ts:85-99`).
**Reproduction:** pre-fix, a third same-label create in one minute reused the minute-stamped slug. Post-fix, three sequential creates produced `collision`, `collision-<stamp>`, and `collision-<stamp>-<rand>`, and the first operation’s `cyber/{ledger,facts,relations}.jsonl` remained intact.
**Re-verify:** in a disposable workspace, run `operation new "Collision"` three times and confirm three distinct slugs and directories.
**Related:** `ENG-02`, `V-S2`.

### RISK-PERM-07 — Security-state writes had no permission gate, and `deny` rules were not enforced

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/tools/opsec.ts`, `scope.ts`, `finding.ts` and `observation.ts` contained no `ctx.ask` and were absent from the defaults at `packages/axiomsec/src/agent/agent.ts`, so they resolved to the catch-all `"*": "allow"`. `packages/axiomsec/src/tools/question.ts` and `plan.ts` never consulted the engine, so the declared `question`/`plan_exit` `deny` rules were unreachable. A stored “always” approval was appended *after* the live ruleset in `packages/axiomsec/src/permissions/evaluate.ts`, so it outranked an explicit user `deny`.
**Why it matters:** the model could downgrade `strict` opsec (re-enabling third-party intel leakage), rewrite the enforcement policy, mint reportable findings, and delete observations without a human decision — and a `deny` rule was decorative.
**Fix:** `ctx.ask` on the `opsec`, `scope`, `finding` and `observation` write paths; `finding` and `observation` default to `ask`; `question`/`plan_exit` consult the engine; `Permission.disabled` now filters denied tools out of the registry; `Permission.decide` resolves the live ruleset first, lets a stored approval satisfy an `ask`, and never lets it override a `deny`.
**Reproduction (pre-fix):** `axiomsec debug agent security --tool opsec --params '{"action":"set","level":"normal"}'` succeeded with no prompt. Post-fix it exits 1 with `permission 'scope' resolves to ask`; `--dangerously-skip-permissions` runs it and prints the bypass.
**Re-verify:** `VERIFICATION.md` `V-S13`; `packages/axiomsec/test/permissions/permission.test.ts`.
**Related:** `SEC-03`, `RISK-PERM-01`, `RISK-PERM-04`, `RISK-SCOPE-02`, `V-S3`, `V-S13`.

### RISK-AUDIT-01 — Plugin tools bypassed the audit wrapper

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/tools/registry.ts` `fromPlugin` returned a raw `{id, parameters, description, execute}` object and pushed it into `custom`, which was never passed through `Tool.init` (all 45 built-ins were). Consequences: no `tool.called`/`tool.completed`/`tool.error` ledger events, no Zod validation of the model-supplied arguments, no workflow progress, no context refresh, and no side-effect contract.
**Why it matters:** a user-installed plugin could perform side effects with zero audit trail, violating `ENG-04`.
**Fix:** `Tool.wrapDef` (`packages/axiomsec/src/tools/tool.ts`) applies the standard wrapper to externally supplied definitions, and the registry routes plugin and config-file tools through it. The plugin API gained an optional `side_effects` field so the published contract is honest.
**Re-verify:** install a plugin tool, call it, and confirm a `tool.called`/`tool.completed` pair appears in the operation ledger.
**Related:** `ENG-04`, `ENG-07`, `RISK-AUDIT-02`, `V-S3`.

### RISK-AUDIT-02 — MCP tools were auto-approved and never audited

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/session/prompt.ts` asked with a dynamic `<server>:<tool>` permission key; the catch-all `"*": "allow"` rule matched it, so the ask never became a human decision. The MCP tools were added to the tool map directly, so they never passed through the registry wrapper and produced no ledger events at all.
**Why it matters:** a third-party MCP server could run any tool with no prompt and no audit record.
**Fix:** MCP tools use the `mcp` permission with the sanitized `<server>_<tool>` key as the pattern, `mcp` defaults to `ask` (`packages/axiomsec/src/agent/agent.ts`), and the call is ledgered as `tool.called`/`tool.completed` in `packages/axiomsec/src/session/prompt.ts`.
**Residual found 2026-10-22:** the first fix used `mcp:<key>`, which the `mcp` default rule could not match, so asks still fell through to allow; failures were also unaudited. Both are fixed and covered by `test/e2e/mcp.test.ts`; see `RISK-MCP-01` and `RISK-AUDIT-06`.
**Re-verify:** `bun test packages/axiomsec/test/e2e/mcp.test.ts` — ask, deny, allow and ledger assertions run against a local MCP fixture.
**Related:** `SEC-03`, `ENG-04`, `RISK-AUDIT-01`, `RISK-MCP-01`, `RISK-AUDIT-06`, `V-S3`.

### RISK-PERSIST-04 — Scope and opsec lived in a projection, not the canonical database

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/operation/operation.ts` `readProjectedOperationFact` read `cyber/facts.jsonl` *first* and only fell back to SQLite, and `setOpsec` wrote **only** that file — the `cyber_fact` rows kept `opsec: "normal"` forever. `Operation.readBoundary` (and therefore the Guard) consumed the projected value.
**Why it matters:** the enforcement input was a derived file. Losing or truncating the projection silently reverted the boundary to `normal`, re-enabling third-party intel leakage — the exact outcome `ENG-02` forbids.
**Fix:** `setOpsec` writes the `operation_state` and `scope_policy` facts to SQLite first and mirrors them into the projection (`writeOperationFacts`); the read path prefers the database and falls back to the projection only for operations created by an older build.
**Reproduction (post-fix):** after `opsec set strict`, delete `.axiomsec/operation/<slug>/cyber/facts.jsonl`; `opsec status` still reports `Opsec: strict` and the `cyber_fact` table holds the row. Pre-fix the same deletion reverted the level to `normal`.
**Re-verify:** `VERIFICATION.md` `V-S13`.
**Related:** `ENG-02`, `ENG-07`, `RISK-PERSIST-02`, `V-S2`, `V-S13`.

### RISK-PERSIST-05 — One malformed manifest line bricked the evidence locker

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/evidence/store.ts` `readManifest` did `.map((l) => Entry.parse(JSON.parse(l)))` with no per-line tolerance, and `put` called it inside the lock. `Evidence.put` also wrote the artifact with a plain `writeFile`, so a crash could leave a truncated file under a digest that claimed it was complete.
**Why it matters:** a single torn or hand-edited line made `list`, `get`, `verify` and `put` all throw — the operation could never record evidence again, and every finding promotion, report build and share build for it failed.
**Fix:** the manifest reader skips malformed lines, counts them and logs them; artifacts are written to a temp file and renamed.
**Reproduction (pre-fix):** appending `TORN LINE NOT JSON` to `manifest.jsonl` made both `list()` and `put()` throw `SyntaxError`. Post-fix the good entries stay readable, new evidence is still accepted, and the damage is logged.
**Re-verify:** `packages/axiomsec/test/core/evidence/store.test.ts`.
**Related:** `SEC-04`, `ENG-07`, `RISK-PERSIST-01`, `V-S4`.

## Medium

### RISK-PROOF-04 — The deliverable contradicted itself on reportable findings

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/cyber/cyber.ts` `projectStateFromParts` built `ProjectedFinding` without `replay_exemption` (only `replay_present` and `replay_reason`), while `packages/axiomsec/src/core/cyber/finding.ts` `summarizeFindingFact` carried it. `isReportableFinding` needs the *structured* exemption, so the two paths disagreed: `packages/axiomsec/src/core/deliverable/build.ts:143` bucketed the projected findings (0 reportable) while `:499` counted the summarized ones (1 reportable) into the same manifest.
**Why it matters:** a legitimately exempt finding was printed under “Suspected Findings” in `report.md` while `manifest.json` said it was reportable, and `snapshot.counts.reportable_findings` under-counted it. The deliverable disagreed with itself.
**Fix:** `ProjectedFinding` now carries `replay_exemption` and the projection populates it from the fact value.
**Re-verify:** promote a finding with a structured exemption, build a report, and confirm the body bucket and the manifest count agree.
**Related:** `SEC-05`, `RISK-PROOF-01`, `RISK-PROOF-03`, `V-S4`.

### RISK-PROOF-05 — Candidates were counted and rendered as suspected findings

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/cyber/finding.ts` `isSuspectedFinding` was `!isReportableFinding && !isRejectedFinding`, which is true for a candidate. `bucketFindings` therefore put every candidate in the suspected bucket, and the `finding` tool and `report.md` rendered them under “Suspected Findings” with no candidates bucket of their own.
**Why it matters:** candidates were double counted (`candidates=N … suspected=M` with `M` including `N`) and appeared twice in the report.
**Fix:** `isSuspectedFinding` requires `kind === "finding"`; the `finding` tool and the deliverable render an explicit “Candidate Findings” bucket. Rejected and stale *candidates* stay visible in the rejected bucket.
**Re-verify:** `packages/axiomsec/test/core/cyber/finding.test.ts`.
**Related:** `SEC-05`, `RISK-PROOF-04`, `V-S4`.

### RISK-PERM-08 — Permission matching was platform-dependent

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/support/wildcard.ts` used the `i` regex flag on Windows only (`process.platform === "win32" ? "si" : "s"`), so the same operator rule resolved differently on Windows than on the platforms CI runs.
**Why it matters:** an operator rule behaved differently per platform, and the difference was invisible.
**Fix:** matching is case-sensitive on every platform. Permission keys are identifiers, and the case-sensitive behaviour is the one the CI platforms already had.
**Re-verify:** `packages/axiomsec/test/permissions/permission.test.ts`.
**Related:** `SEC-03`, `ENG-06`, `RISK-PERM-07`.

### RISK-SECRET-04 — Redaction missed nested secret objects and unquoted auth/cookie assignments

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/replay/redact.ts` re-keyed object children with the *child* key, so the parent hint was dropped: `{"token": {"value": "SECRET"}}` was not redacted. `SECRET_ASSIGN_RE` also omitted `authorization`, `proxy-authorization` and `cookie`, so `Authorization=Bearer <token>` and `Cookie=session=<id>` survived in text artifacts.
**Why it matters:** the leak reached share bundles, ledger entries and replay files. The key pattern existed, so this was not covered by the accepted “bare opaque value” residual (`RISK-SECRET-03`).
**Fix:** a sensitive key whose value is an object or array is redacted as a whole; a dedicated rule redacts `authorization`/`cookie` assignment forms to the end of the line.
**Reproduction (pre-fix):** `redactValue({token:{value:"SUPERSECRET"}}, "on")` returned the secret unchanged, and `redactString("Authorization=Bearer abc123", "on")` was unchanged. Post-fix both are redacted.
**Re-verify:** `packages/axiomsec/test/core/replay/redact.test.ts`; `VERIFICATION.md` `V-S6`.
**Related:** `SEC-06`, `RISK-SECRET-01`, `RISK-SECRET-03`, `V-S6`.

### RISK-SECRET-05 — Tool args were persisted unredacted in the session database

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** the ledger copy of the tool args was redacted (`packages/axiomsec/src/tools/tool.ts`), but the session tool part stored the raw args (`packages/axiomsec/src/session/prompt.ts` `input: args`), and that part is persisted to SQLite and included in session exports.
**Why it matters:** `vault set` and `identity add` take the secret as a tool argument, so every real credential landed verbatim in the session database — which is not the 0600 file the vault is.
**Fix:** the session tool part uses the same `Tool.redactToolInput` as the ledger. **Residual found 2026-10-22:** the processor wrote the first `tool-call` part with the raw streamed input (`packages/axiomsec/src/session/processor.ts` `input: value.input`) before the wrapper redacted it; the later metadata update did not overwrite that row. The processor now redacts at the first write. Regression: `packages/axiomsec/test/e2e/agent-advanced.test.ts` (“a vault secret is redacted in the persisted transcript and ledger”).
**Re-verify:** `OPENROUTER_LIVE` is not needed; run the e2e case above. It reads `part.data` from SQLite, the ledger and stdout and asserts the canary appears in none of them.
**Related:** `SEC-06`, `RISK-SECRET-02`, `RISK-SECRET-03`, `RISK-SECRET-06`.

### RISK-PERSIST-06 — The one-time database migration ran on every command

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/index.ts` used a hardcoded marker path `Global.Path.data/axiomsec.db`, but `packages/axiomsec/src/storage/db.ts` resolves the real path from the channel suffix and `AXIOMSEC_DB`. The marker was never created, so with `AXIOMSEC_DB` set every invocation re-ran the JSON→SQLite migration and printed the “one time database migration” banner.
**Why it matters:** a misleading banner on every command and needless work at every start.
**Fix:** the marker is the resolved database path, so the migration runs exactly once.
**Reproduction (post-fix):** with `AXIOMSEC_DB` set, the banner appears on the first command and on no later one.
**Re-verify:** run two commands in a row with `AXIOMSEC_DB` set and count the banners.
**Related:** `ENG-05`, `V-S1`, `V-S8`.

### RISK-PERSIST-07 — `share` left a full staging copy of the operation behind

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/tools/share.ts` staged evidence, cyber, workflow and context into `<op>/share-<stamp>/` and never removed it, so every share grew the operation directory without bound.
**Fix:** the staging tree is removed once the tarball is written.
**Re-verify:** build a share bundle and confirm the operation directory contains only the tarball.
**Related:** `ENG-07`, `V-S6`.

### RISK-PERSIST-08 — Fact and relation writes were a non-atomic select-then-insert

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/cyber/cyber.ts` `upsertFact` and `upsertRelation` read the existing row and then inserted, with no `onConflictDoUpdate`. Two writers that both saw “no existing row” raced on the unique index, and the losing UNIQUE error was swallowed by the caller.
**Why it matters:** a fact or relation could be silently lost, and the ledger would still show the call.
**Fix:** both are single atomic upserts; the stored row id is resolved afterwards so the projection references the row that exists.
**Re-verify:** run concurrent writers against one operation and confirm no row is lost.
**Related:** `ENG-02`, `ENG-07`, `RISK-PERSIST-01`.

### RISK-PERSIST-09 — Operation-level projection appends bypassed the file lock

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/operation/operation.ts` `rename` and `setOpsec` appended to `cyber/*.jsonl` with a bare `appendFile`, while `packages/axiomsec/src/core/cyber/cyber.ts` locks the same files. A concurrent appender could interleave a partial line, and the readers skip unparsable lines silently.
**Fix:** both take the same `cyber:<dir>:<file>` lock.
**Re-verify:** run a rename and a tool call concurrently against one operation and check the projection parses.
**Related:** `ENG-02`, `ENG-07`, `RISK-PERSIST-01`.

### RISK-PERF-01 — Projections grew without bound and were re-parsed on every call

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence (pre-fix):** `readProjectedLedger`, `readProjectedFacts` and `readProjectedRelations` in `packages/axiomsec/src/core/cyber/cyber.ts` parsed the whole projection file into a map, and `refreshDerivedContext` ran after nearly every non-read tool call, so the cost of a call grew with the length of the operation.
**Why it matters:** quadratic cost over a long session, and `Cyber.readProjectedState` silently fell back to empty state after its 2 s guard, so the deliverable degraded on long operations.
**Fix:** the projection readers take the tail of the file (1 MB) instead of the whole thing.
**Residual:** the files still grow on disk; compaction is not implemented.
**Re-verify:** run a long operation and compare the per-call latency.
**Related:** `ENG-02`, `ENG-03`.

### RISK-AUDIT-03 — Side-effect metadata is still inconsistent across cyber tools

**Status:** fixed 2026-10-22 · **Severity:** low · **Verified:** 2026-10-22
**Evidence (pre-fix):** most tools did not declare `side_effects`; the wrapper published `side_effects: []` even for writers such as `doctor`, `analyze`, `crypto`, the triage adapters and `bash`.
**Fix:** `packages/axiomsec/src/tools/tool.ts` now owns `DEFAULT_SIDE_EFFECTS`, a conservative contract for every built-in tool id. Per-call metadata still wins; the wrapper uses the table only when a result carries no effects. `test/policy/invariants.test.ts` requires every `Tool.define` id to have an entry and only known categories, and `test/security/tools-surface.test.ts` asserts the published contract for `crypto` and `doctor`.
**Why it matters:** a consumer that trusts `facts_written`/`evidence_written` no longer mis-classifies an unannotated call, and read-only tools do not force an unnecessary context refresh.
**Re-verify:** `bun test test/policy/invariants.test.ts test/security/tools-surface.test.ts`.
**Related:** `ENG-04`, `RISK-AUDIT-01`.

### RISK-AUDIT-04 — Ledger write failures are still swallowed in the tool wrapper

**Status:** mitigated 2026-10-22 (fail-open; failure is now visible) · **Severity:** medium · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/tools/tool.ts` catches completion-ledger failures, logs `tool.completed ledger write failed`, and reports `audit_logged: false` instead of claiming the call was recorded. A database or lock failure can still leave a `tool.called` row with no completion.
**Residual:** the failed event is not retried or persisted elsewhere; the operation context has no degraded marker. `ENG-07` still expects a durable marker.
**Mitigation:** the tool executes and reports its own error, and the transcript now exposes the degraded audit state.
**Fix direction:** write a durable degraded-audit marker through a separate channel when the ledger is unavailable.
**Related:** `ENG-07`, `ENG-04`, `RISK-PERSIST-01`.

### RISK-NET-03 — Server accepts auth tokens in URLs

**Status:** fixed 2026-10-21 · **Severity:** medium · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/server/middleware.ts:43-45` copied an `auth_token` query parameter into the Authorization header; the experimental HTTP API did the same in `server/instance/httpapi/server.ts`.
**Why it matters:** URLs are commonly retained in browser history, proxy logs, and referrers, so a token in a URL can leak outside request headers.
**Fix:** `packages/axiomsec/src/server/middleware.ts:39-47` and `server/instance/httpapi/server.ts` no longer read `auth_token`; only a standard `Authorization` header authenticates. The query schema still supports `directory`/`workspace`.
**Reproduction:** with `AXIOMSEC_SERVER_PASSWORD=canary`, `/config?auth_token=YXhpb21zZWM6Y2FuYXJ5` returns 401, Basic auth returns 200, and no auth returns 401.
**Re-verify:** `rg -n "auth_token" packages/axiomsec/src/server` (expect none); repeat the three requests in `VERIFICATION.md` §V-S5.
**Safe check:** Loopback only, canary password.
**Related:** `SEC-07`, `RISK-NET-02`, `V-S5`.

### RISK-PERM-04 — Workspace-write and workflow tools default to allow

**Status:** accepted · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/agent/agent.ts:110-127` keeps `"*": "allow"` for tools outside the sensitive set; `edit`/`write`/`apply_patch` map to the `edit` permission, and `task`/`play`/`runbook`/`workspace` have no default ask. Their `ctx.ask` calls resolve to allow.
**Why it matters:** An operation-attached model can modify files or advance workflows without a prompt under the default ruleset, even though network/shell/secret tools now ask.
**Mitigation:** `external_directory` still asks outside the workspace; edit tools call `ctx.ask`; users can set `"edit": "ask"` or narrower rules. This is an intentional autonomy tradeoff for the primary coding/research agents.
**Re-verify:** `sed -n '110,130p' packages/axiomsec/src/agent/agent.ts`; run `debug agent security --tool write` on a disposable workspace and observe the resolved rule.
**Safe check:** Disposable workspace only.
**Fix direction:** Consider `edit: "ask"` by default for operation-attached agents, or require an explicit workspace marker for non-interactive runs.
**Related:** `SEC-03`, `RISK-PERM-01`, `RISK-PERM-03`, `V-S3`.

### RISK-SECRET-03 — Vault is plaintext and request bodies are not redacted

**Status:** open · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `packages/axiomsec/src/core/vault.ts:45-49` stores secrets as plaintext JSON at 0600; `packages/axiomsec/src/tools/http-request.ts` accepts arbitrary request bodies, and `packages/axiomsec/src/tools/net.ts` accepts arbitrary payloads. `redactToolInput` covers key-based secrets and recognizable text patterns, but not bare opaque values.
**Reproduction:** a text evidence artifact containing only `LOCK-CANARY-EVIDENCE` (no header or key) appeared twice in a share bundle built with `redact:true`. The earlier header/JSON canaries were removed, so this is specifically the opaque-value residual.
**Why it matters:** A bare credential placed in a body, payload, or evidence text can reach the ledger, evidence, or a share bundle even though headers and named secret fields are redacted. The vault protects only by filesystem mode.
**Re-verify:** set a canary vault value and inspect the vault file mode; add a bare canary text artifact, build a share with `redact:true`, and grep the tarball.
**Safe check:** Canary values, disposable loopback only.
**Fix direction:** Encrypt or keychain-back the vault; avoid ledgering bodies by default; warn when redaction is enabled but cannot classify opaque content.
**Related:** `SEC-06`, `RISK-SECRET-01`, `RISK-SECRET-02`, `V-S3`, `V-S4`, `V-S6`.

### RISK-PERSIST-01 — Unlocked JSONL and manifest appends

**Status:** fixed 2026-10-21 · **Severity:** medium · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/core/evidence/store.ts:89-102` (read manifest, then append; no lock), `packages/axiomsec/src/core/cyber/cyber.ts:489` (append to projection); the legacy operation store documents no multi-writer semantics (`packages/axiomsec/src/core/operation/store.ts:9-10`).
**Why it matters:** Two processes could append duplicate manifest entries or interleave JSONL lines; evidence reads could see a torn state.
**Fix:** `packages/axiomsec/src/support/lock.ts:1-7` wraps the shared `Flock` with a 30-second timeout and a graceful fallback when the lock directory is not configured. `evidence/store.ts:52-70,103-119` locks manifest reads and the read/append critical section; `cyber.ts:490-492` locks projection appends.
**Reproduction:** eight concurrent puts of the same canary produced **1** manifest line with the lock; the unlocked control produced **3**. The locked case was run with `Flock.setGlobal` in a disposable state directory.
**Residual:** module-level callers without a configured `Flock` global run unlocked (fallback); external processes that read the JSONL files directly (outside `Evidence.list`/`get`) can still observe a partial last line.
**Re-verify:** `VERIFICATION.md` §V-S10.
**Related:** `ENG-02`, `SEC-04`, `V-S4`.

### RISK-PERSIST-03 — Migration failure is swallowed for the process lifetime

**Status:** fixed 2026-10-21 · **Severity:** medium · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/core/operation/operation.ts:26-31` — the workspace was added to `migrated` before `migrate()` ran, and the error was discarded; `packages/axiomsec/src/core/operation/migration.ts:73-80` also swallowed per-operation failures.
**Why it matters:** A transient failure left the workspace unmigrated with no retry until process restart; the UI could appear healthy while projections were missing.
**Fix:** `packages/axiomsec/src/core/operation/operation.ts:27-46` marks the workspace only after a successful migration, logs a warning once per workspace, and retries on the next access. `packages/axiomsec/src/core/operation/migration.ts:73-86` collects per-operation failures and throws an aggregate error instead of discarding them.
**Reproduction:** the legacy migration happy path still works: a fixture with `events.jsonl` gains `_legacy/events.jsonl` and a migrated `axiomsec.md`, and `operation list` shows the migrated operation. Failure injection was not run; the retry/log path is code-verified.
**Re-verify:** create the fixture in `VERIFICATION.md` §V-S2 and inspect the migrated files; review the `ensureMigrated` retry path.
**Related:** `ENG-07`, `V-S2`.

### RISK-TOOL-01 — `debug agent --tool` never executed the tool

**Status:** fixed 2026-10-21 · **Severity:** medium · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/cli/cmd/debug/agent.ts:60` awaited `tool.execute(params, ctx)`, but tool definitions return `Effect.Effect<ExecuteResult>` (`packages/axiomsec/src/tools/tool.ts:47-56`). The command printed the effect object (`{"_id":"Effect","op":"WithFiber"}`) and exited 0 without running the tool.
**Why it matters:** The documented `V-S3`/`V-S4` verification path silently verified nothing; operators could believe a tool smoke test passed when no tool code ran.
**Fix:** `packages/axiomsec/src/cli/cmd/debug/agent.ts:60` now runs the effect through `AppRuntime.runPromise` before printing the result.
**Re-verify:** with a configured model in a disposable workspace, run `debug agent security --tool scope --params '{"action":"status"}'`; the output must be the tool result, not an Effect object.
**Safe check:** Disposable workspace only; ask-level tools require `--dangerously-skip-permissions` (`RISK-PERM-02` fixed 2026-10-21).
**Related:** `RISK-PERM-02`, `V-S3`, `V-S4`.

### RISK-TIME-01 — Timeout gaps in network/subprocess paths

**Status:** fixed 2026-10-21 (SDK streaming remains intentionally unbounded) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/sdk/src/v2/client.ts:47-57` (`req.timeout = false`); `packages/axiomsec/src/npm/npm.ts:43` (unbounded registry `fetch`); `packages/axiomsec/src/installer/installation.ts:107,123,153` (spawns without timeout); `packages/axiomsec/src/tools/share.ts:84-97,190-198` (signing/tar without timeout); `packages/axiomsec/src/cli/cmd/replay.ts:126` (minisign spawn).
**Why it matters:** A hung registry, installer, signer, or tar could stall the agent loop indefinitely.
**Fix:** replay signing already had 10-second minisign/cosign timeouts (`replay.ts:129,145`). `tools/share.ts:136,145` now bounds signing to 10 seconds and kills a tar after 120 seconds (`share.ts:245-247`). `npm.ts:43` uses `AbortSignal.timeout(15_000)` and falls back to the cached version. `installer/installation.ts:113,133,168` bounds read-only commands to 30 seconds and installers/upgrade scripts to 10 minutes with a typed failure result.
**Reproduction:** share build with redaction still succeeds end-to-end after the tar timer change; the other paths are code-verified because they require package registries or installers.
**Residual:** `packages/sdk/src/v2/client.ts:47-57` deliberately disables request timeout for long-lived streaming; SDK consumers must supply their own cancellation. Re-audit any new bare `fetch`/`spawn` before adding it.
**Re-verify:** `rg -n "fetch\\(|spawn\\(|spawnSync\\(|exec\\(" packages/axiomsec/src packages/sdk/src` and inspect each call for a signal/timeout; run `VERIFICATION.md` §V-S6.
**Safe check:** Local, disposable share bundle; do not start a hanging registry request.
**Related:** `ENG-03`, `RISK-BUILD-01`, `RISK-BUILD-04`, `V-S6`, `V-S7`, `V-S8`.

### RISK-BUILD-01 — Hardcoded `/tmp` paths

**Status:** fixed 2026-10-21 · **Severity:** medium · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/drizzle.config.ts:8` (`/tmp/axiomsec-dev.db`); `packages/axiomsec/src/cli/cmd/replay.ts:122` (`/tmp/axiomsec-sign-*.txt`).
**Why it matters:** Windows dev and CI can fail or write to an unexpected location; temp files can collide.
**Fix:** `packages/axiomsec/drizzle.config.ts:1-10` now uses `os.tmpdir()` with an `AXIOMSEC_DEV_DB` override. `packages/axiomsec/src/cli/cmd/replay.ts:4,125-137` uses `os.tmpdir()` plus a random suffix and removes the temp input/signature files in `finally`; minisign/cosign spawns now have a 10-second timeout (`replay.ts:129,145`).
**Re-verify:** `bun -e 'const cfg=(await import("./packages/axiomsec/drizzle.config.ts")).default; console.log(cfg.dbCredentials.url)'` (resolved Windows temp path); `replay verify` still reports `sha256: ok`.
**Safe check:** Local, disposable files only.
**Related:** `ENG-06`, `RISK-TIME-01`, `V-S7`, `V-S8`.

### RISK-SNAPSHOT-01 — Snapshot ignore check exceeded Windows command-line limits

**Status:** fixed 2026-10-21 · **Severity:** medium · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/snapshots/snapshot.ts:166-188` passed every changed path as trailing arguments to `git ls-files`. A mock-provider run in a workspace with 536 tracked paths emitted `ENAMETOOLONG: name too long, uv_spawn` as a `session.error` immediately after each model step, even though the model response had completed.
**Why it matters:** The core agent loop reported an error after every response on large or noisy workspaces on Windows; the snapshot patch could not finalize.
**Fix:** `packages/axiomsec/src/snapshots/snapshot.ts:160-190` batches the pathspecs in groups of 100 and unions the results, keeping each git command line bounded.
**Reproduction:** with the local mock provider in `VERIFICATION.md` §V-S11, the pre-fix run logged a `session.error` after `step_finish`; the post-fix run exits 0 with a text event, `step_finish`, and zero error events in the same workspace.
**Re-verify:** `VERIFICATION.md` §V-S11; `rg -n "\\.\\.\\.files" packages/axiomsec/src/snapshots/snapshot.ts` should not show an unbounded git argument list.
**Safe check:** Loopback mock provider and disposable workspace only.
**Related:** `ENG-03`, `ENG-06`, `V-S11`.

### RISK-BUILD-02 — Generated artifacts can drift; SDK generator is missing

**Status:** open (blocked on the missing generator config) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `packages/sdk/src/v2/gen/*` is marked auto-generated by `@hey-api/openapi-ts`; `packages/sdk/package.json` has only `typecheck`, no generate script or generator dependency; `packages/axiomsec/script/generate.ts` writes `packages/axiomsec/src/providers/models-snapshot.*`, which `.gitignore:48` ignores.
**Verified:** `axiomsec generate` prints a valid OpenAPI 3.1.1 document (305,279 bytes in the disposable workspace), so the input side is reproducible.
**Why it matters:** A route/schema change can leave the SDK stale; a fresh checkout cannot regenerate `packages/sdk/src/v2/gen/*` without recovering the original `@hey-api/openapi-ts` version and plugin configuration.
**Blocker:** Establishing the generator requires pinning `@hey-api/openapi-ts` (lockfile change) and recovering its exact output/plugin config. Do not hand-edit `gen/*` or invent a config that silently changes the generated client.
**Re-verify:** `sed -n '26,28p' packages/sdk/package.json`; `axiomsec generate | head`; inspect the `gen/*` headers.
**Safe check:** Read-only; generation is a separate repo-structure change.
**Fix direction:** Recover the generator version/config, check it in with a pinned script, and diff the regenerated output before committing.
**Related:** `ENG-05`, `CHANGE-PLAYBOOKS.md` §F, `V-S5`, `V-S8`.

### RISK-BUILD-03 — Build failed resolving Playwright optional dependencies

**Status:** fixed 2026-10-21 (Release 0.2.0) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `bun run --cwd packages/axiomsec build --single --skip-install` failed on Windows while bundling `playwright-core` with “Could not resolve: `electron`” and “Could not resolve: `chromium-bidi/...`” under `node_modules/.bun/playwright-core@1.59.1`; reproduced with both Bun 1.3.11 and 1.4.3. Playwright is used by `packages/axiomsec/src/tools/browser.ts`.
**Why it matters:** The failure blocks the artifact build, startup smoke, GitHub release, and npm/Docker publish. `playwright-core` conditionally requires Electron/BiDi modules that are not in the lockfile.
**Fix:** `packages/axiomsec/script/build.ts` now externalizes `electron`, `chromium-bidi`, and `chromium-bidi/*` alongside `node-gyp`. The build and `--version` smoke pass with Bun 1.3.11 and 1.4.3.
**Re-verify:** `bun run --cwd packages/axiomsec build --single --skip-install`; confirm the binary prints a version. If the bundler starts resolving those optional paths again, reopen this risk.
**Safe check:** Local build only; do not publish or sign artifacts.
**Fix direction:** Keep optional Playwright paths external; do not add heavyweight Electron dependencies just to satisfy the bundler.
**Related:** `RISK-BUILD-01`, `RISK-BUILD-02`, `V-S8`.

### RISK-BUILD-04 — Share tarball failed on Windows absolute paths

**Status:** fixed 2026-10-21 · **Severity:** medium · **Verified:** 2026-10-21
**Evidence (pre-fix):** `packages/axiomsec/src/tools/share.ts:190-193` passed the absolute `C:\...` tarball and staging paths to `tar`; GNU tar interpreted the drive letter as a remote host: `tar (child): Cannot connect to C: resolve failed` (exit 2).
**Why it matters:** `share build` could not produce a bundle on Windows, blocking evidence handoff and the V-S6 canary check.
**Fix:** `packages/axiomsec/src/tools/share.ts:239-243` spawns tar with `cwd: opDir` and relative basenames, so no drive-letter argument reaches tar. The returned path and metadata remain absolute.
**Re-verify:** run `debug agent security --tool share --dangerously-skip-permissions --params '{"action":"build"}'` in a disposable Windows workspace; the tarball must exist and `tar -tzf` must list it.
**Safe check:** Disposable workspace, canary content only.
**Related:** `RISK-BUILD-01`, `V-S6`, `V-S8`.

### RISK-RELEASE-01 — Release test gate failed when no tests existed

**Status:** fixed 2026-10-21 (Release 0.2.0) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `.github/workflows/release.yml` originally ran `bun test --timeout 30000` unconditionally in `packages/axiomsec`; `bun test` exits 1 with “No tests found!” (verified with Bun 1.3.11); root `package.json:12` is a no-op; `.gitignore:35-47` ignores tests; `bunfig.toml:4-5` redirects the test root.
**Why it matters:** The release gate failed before any artifact or GitHub release could be produced, even though the lite repo intentionally ships no tests.
**Fix:** The workflow now runs `bun test` only when `*.test.*`/`*.spec.*` files exist; otherwise it prints a skip message. This keeps a real gate for future tests without failing on zero tests.
**Re-verify:** `sed -n '40,62p' .github/workflows/release.yml`; run `bun test --timeout 30000` in `packages/axiomsec` and confirm it still exits 1 when no tests exist (the workflow skips it). Do not run the release workflow.
**Safe check:** Read-only or a disposable test command.
**Fix direction:** Add real tests and remove the lite-repo caveat when the test harness exists.
**Related:** `RISK-CI-01`, `V-S8`, `VERIFICATION.md`.

### RISK-RELEASE-02 - The npm and Docker publish jobs fail without repository secrets

**Status:** open · **Severity:** medium · **Verified:** 2026-10-22
**Evidence:** the `Publish to npm` job failed at "Publish packages" for v0.2.0, v0.3.1 and v0.4.0; the `Publish Docker Image` job failed at `docker/login-action` for the same three releases. `axiomsec` is not on npm at all (registry lookup returns 404), and neither are `@axiomsec/plugin`, `@axiomsec/sdk` or `@axiomsec/shared`. The `axiomsec` name is still available, so publishing would claim it. The jobs read `secrets.NPM_TOKEN`, `secrets.DOCKERHUB_USERNAME` and `secrets.DOCKERHUB_TOKEN`, and no prerequisite for them was documented anywhere in the repository.
**Why it matters:** every release so far has produced a GitHub release with its per-platform archives but has never shipped to npm or Docker Hub. The failure surfaced as a bare registry error with no indication that a secret was missing, and the required secrets were undocumented, so the next operator had nothing to act on.
**Fix:** both jobs now check for their secret before use and fail with a message that names it. `docs/agents/CHANGE-PLAYBOOKS.md` §I documents the release procedure and the required secrets.
**Residual:** the secrets themselves have to be added to the repository settings; that is an operator action, not a code change. The GitHub release and the npm/Docker publishes are separate jobs, so a red publish job does not remove the release.
**Re-verify:** read `docs/agents/CHANGE-PLAYBOOKS.md` §I; check the release page assets for a new tag.
**Safe check:** read-only.
**Related:** `RISK-RELEASE-01`, `RISK-BUILD-04`.

### RISK-SESSION-01 — `axiomsec run` dropped the agent's answer after a tool call

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/cli/cmd/run.ts` broke out of its event loop on the first `session.status` event with `type: "idle"`. The session reports `idle` after **every** step (`packages/axiomsec/src/session/processor.ts:565`), so the loop ended after the tool-call step and never saw the follow-up step that consumed the tool result. The agent produced its answer — the text was in the session — but `axiomsec run` printed nothing and exited 0.
**Why it matters:** a headless consumer of `axiomsec run --format json` sees an empty response and concludes the agent did nothing. The failure is silent: exit code 0, no error, no output. It was invisible to every other test because the session record was correct — only the *stream* was wrong.
**Fix:** the event loop now ends on an idle that follows the finished prompt rather than on the first idle, and the stream is closed with an abort signal once the prompt resolves.
**Reproduction (pre-fix):** with a scripted model that calls `scope` and then answers, the run printed `step_start`, `tool_use`, `step_finish` and no text, while the session held `text "AFTER-TOOL"`. Post-fix the text is printed.
**Re-verify:** `packages/axiomsec/test/e2e/agent.test.ts` — "a tool call from the model reaches the operation and is ledgered".
**Related:** `ENG-04`, `RISK-AUDIT-01`, `V-S11`.

### RISK-CI-02 - Clean-install typecheck failed on an undeclared `glob` dependency

**Status:** fixed 2026-10-21 (Release 0.2.0) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** The Release workflow failed at `bun typecheck` with `packages/shared/src/util/glob.ts(1,50): error TS2307: Cannot find module 'glob' or its corresponding type declarations.` Local Windows checks passed because `glob` was hoisted from `packages/axiomsec`.
**Why it matters:** A clean Linux install must not rely on a sibling package’s transitive dependency; the release failed before any artifact was built.
**Fix:** `packages/shared/package.json` now declares `"glob": "13.0.5"` and the lockfile workspace entry matches. `bun install --frozen-lockfile` and `bun turbo typecheck` pass.
**Re-verify:** `bun install --frozen-lockfile`; `bun turbo typecheck --force`; confirm `glob` is in `packages/shared/package.json` dependencies.
**Safe check:** Local verification only.
**Fix direction:** Declare every imported package in the package that imports it; do not rely on workspace hoisting.
**Related:** `RISK-CI-01`, `V-S8`.

### RISK-CI-03 — Clean-install typecheck failed on an undeclared GitLab provider import

**Status:** fixed 2026-10-21 (Release 0.2.0) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** After fixing `glob`, the Release workflow still failed at `bun typecheck` with `packages/axiomsec/src/providers/provider.ts(507,46): error TS2307: Cannot find module 'gitlab-ai-provider'`; the build failed on the same missing module. The package was present only in a local hoisted `node_modules`.
**Why it matters:** The GitLab provider is imported by `provider.ts`; clean installs could not typecheck or bundle it, blocking release artifacts.
**Fix:** `packages/axiomsec/package.json` now declares `"gitlab-ai-provider": "6.22.0"` and the lockfile includes it with its transitive dependencies. `bun install --frozen-lockfile --linker isolated` followed by `bun turbo typecheck --force` and the single-platform build pass with Bun 1.3.11.
**Re-verify:** `bun install --frozen-lockfile --linker isolated`; `bun turbo typecheck --force`; `bun run --cwd packages/axiomsec build --single --skip-install`.
**Safe check:** Local build only.
**Fix direction:** Declare every provider SDK that `provider.ts` imports; do not rely on hoisting.
**Related:** `RISK-CI-01`, `RISK-CI-02`, `V-S8`.

### RISK-RELEASE-02 — Release referenced a missing postinstall script

**Status:** fixed 2026-10-21 (Release 0.2.0) · **Severity:** medium · **Verified:** 2026-10-21
**Evidence:** `.github/workflows/release.yml:203,245,270` referenced `packages/axiomsec/script/postinstall.mjs`; `ls packages/axiomsec/script` shows only `build.ts` and `generate.ts`.
**Why it matters:** The npm publish job would fail before publishing because the file was copied, required, and referenced by the meta package.
**Fix:** Removed the missing postinstall copy, meta-package script, and required-file check. The `bin/axiomsec` launcher resolves the platform binary from the installed optional dependency, so the install hook was redundant.
**Re-verify:** `rg -n "postinstall" .github/workflows/release.yml packages/axiomsec/bin/axiomsec`; confirm no missing-file reference remains.
**Safe check:** Read-only.
**Fix direction:** If a real postinstall behavior is needed later, restore the file and the publish checks together.
**Related:** `V-S8`.

## Fixed during the 2026-10-22 test campaign

These defects were found while building the layered suite, reproduced against
the built binary or the real provider, fixed, and pinned by a test. Each entry
names the test that must go red if the fix is reverted.

### RISK-SECRET-06 — Inline secrets and replay tool errors escaped redaction

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/core/replay/redact.ts` skipped an `Authorization=`/`Cookie=` assignment when another `[redacted:…]` placeholder appeared later on the same line, so `check Authorization: Bearer SECRET and [redacted:jwt]` kept `SECRET`. `packages/axiomsec/src/core/replay/format.ts` copied `state.error` into a replay without `redactString`, so a tool error containing a header value survived a `--redact` replay.
**Fix:** the assignment guard only skips a value that is already a redaction placeholder (`(?!\s*\[redacted)`), and replay tool errors pass through `redactString`.
**Test:** `test/core/replay/format.test.ts` (“tool errors are redacted too”) and the existing redaction suite.
**Related:** `SEC-06`, `RISK-SECRET-01`, `RISK-SECRET-04`.

### RISK-SCOPE-08 — Scope host matching was case-sensitive

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/core/boundary/evaluate.ts` compared `URL.hostname` (lowercased by the parser) with the raw pattern, so `in_scope: ["Example.COM"]` never matched `https://example.com`. Host-only requests had the same problem in the opposite direction.
**Fix:** scheme-less URL and host patterns compare lowercased values; scheme patterns already used parsed hostnames.
**Test:** `test/core/boundary/edge.test.ts` (“host matching is case-insensitive because DNS names are”, “a scheme-less host pattern is case-insensitive on the hostname”).
**Related:** `SEC-01`, `RISK-SCOPE-04`.

### RISK-PROOF-06 — A blank evidence ref satisfied the evidence half

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence:** `isReportableFinding` and `Oracle.verifyFindingProof` only checked `Array.isArray` and `length > 0`, so `evidence_refs: [""]` or `["   "]` made a finding reportable/proof-passed even though no artifact can resolve to a blank digest.
**Fix:** `hasEvidenceRef` requires at least one non-blank string, and both the predicate and the oracle use it.
**Test:** `test/core/cyber/finding-edge.test.ts` (“an empty-string evidence ref does not count”).
**Related:** `SEC-05`, `RISK-PROOF-01`, `RISK-PROOF-03`.

### RISK-PERSIST-10 — A dead lock owner stalled the next command for 60 seconds

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence:** `packages/shared/src/util/flock.ts` decided staleness only from the heartbeat/meta mtime (`staleMs` 60 s). A command that exited via `process.exit` left a lock behind, and the next command waited the full minute. Reproduced by denying a tool with `debug agent` and then listing the agent: 60.9 s before the fix, ~0.6 s after.
**Fix:** a same-host lock whose recorded PID no longer exists (ESRCH) is immediately stale. A live PID, EPERM, an unknown host or a malformed meta still falls back to the heartbeat age.
**Test:** `test/core/support/flock.test.ts` (dead PID, live PID, foreign host, clean release).
**Related:** `ENG-07`, `RISK-PERSIST-01`.

### RISK-PERSIST-11 — Concurrent evidence puts raced, and an extension could escape the locker

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/core/evidence/store.ts` wrote every artifact to the same `.${sha}.${ext}.tmp` path before the manifest lock, so sixteen concurrent puts of the same bytes rejected with rename errors (reproduced: 5/16 rejected). `ext` was joined into the file name unchecked; `../../../escaped` produced a path outside the evidence directory.
**Fix:** unique temp names per writer, a lost rename race is success when the destination exists, extensions are reduced to a short alphanumeric token on write, and reads fail closed on a malformed manifest extension.
**Test:** `test/core/evidence/edge.test.ts` (sixteen concurrent puts, hostile extensions, hand-edited manifest).
**Related:** `SEC-04`, `SEC-01`, `RISK-PERSIST-05`.

### RISK-CONFIG-01 — Every command installed `@axiomsec/plugin` into every config directory

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/config/config.ts` forked `setupConfigDir` for every config directory unconditionally; it wrote a `.gitignore`, `node_modules` and `package.json` into the project’s `.axiomsec` and contacted npm. When the install was interrupted, the next command waited on the npm lock and stayed alive after printing its result (observed 60 s; `cli-workflow` denied-tool case).
**Fix:** dependency setup runs only when the directory has a plugin file, a `tool`/`tools` directory, or declared plugins.
**Test:** `test/security/cli-workflow.test.ts` (“an explicit deny rule removes a tool from the model-facing surface” completes in ~2 s; the pre-fix run took >60 s).
**Related:** `ENG-03`, `RISK-PERSIST-10`, `RISK-CI-01`.

### RISK-TIME-03 — A permanent quota was retried forever, and `run` exited 0 on it

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/session/retry.ts` had no attempt cap and did not classify a daily free-tier quota as permanent. A live OpenRouter 429 (`free-models-per-day`) kept the process retrying for >3 minutes until killed. `packages/axiomsec/src/cli/cmd/run.ts` captured `session.error` but never set a non-zero exit code, so a headless consumer saw exit 0 with only an error event.
**Fix:** `RETRY_MAX_ATTEMPTS = 10`; `free-models-per-day`, insufficient credits and quota-exceeded messages are not retried; `run` sets exit 1 when it saw a session error.
**Test:** `test/core/session/retry.test.ts`, `test/e2e/agent-advanced.test.ts` (quota and transient-503 cases).
**Reproduction evidence:** live call at 2026-10-22T19:47Z returned exit 1 and one `error` event with the OpenRouter quota message.
**Related:** `ENG-03`, `RISK-PERM-03`.

### RISK-CLI-01 — Operation JSON went to stderr

**Status:** fixed 2026-10-22 · **Severity:** low · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/cli/cmd/operation.ts` used `UI.println`, which writes stderr, for `--format json` and for context/markdown output. `axiomsec operation list --format json > ops.json` produced an empty file.
**Fix:** machine-readable operation output is written to stdout; human status/error messages remain on stderr.
**Test:** `test/security/cli-workflow.test.ts` parses list/show JSON from stdout and errors from stderr.
**Related:** `ENG-04`, `RISK-DOC-02`.

### RISK-TOOL-04 — `debug agent` ignored `toolset_exclude`

**Status:** fixed 2026-10-22 · **Severity:** low · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/session/llm.ts` removes `agent.toolset_exclude` ids for real model requests, but `packages/axiomsec/src/cli/cmd/debug/agent.ts` listed the unfiltered registry. `debug agent osint` showed `scanner`, `crypto` and `net` even though a real osint model never sees them.
**Fix:** the debug listing filters the agent’s excluded ids.
**Test:** `test/security/tools-surface.test.ts` and `test/e2e/agent-advanced.test.ts` (“a specialist lane removes its out-of-lane tools from the model request”).
**Related:** `ENG-04`, `RISK-AUDIT-01`.

### RISK-TOOL-05 — `evidence add_file` discarded the file extension

**Status:** fixed 2026-10-22 · **Severity:** low · **Verified:** 2026-10-22
**Evidence:** `Evidence.put` chose `bin` when neither `mime` nor `ext` was supplied, so a text file imported by `evidence add_file` was stored as `.bin` and `get` refused to preview it. Dotfiles such as `.env` have no `path.extname`.
**Fix:** infer a safe extension from the source path (including dotfiles), and recognize common text extensions for previews.
**Test:** `test/security/cli-workflow.test.ts` (“evidence add_file respects the read and external-directory gates” asserts the stored preview).
**Related:** `SEC-06`, `RISK-PERSIST-05`.

### RISK-INTEL-01 — A version prefixed with `v` was not normalized

**Status:** fixed 2026-10-22 · **Severity:** low · **Verified:** 2026-10-22
**Evidence:** `normalizeComponent`’s product patterns required a digit, so `nginx v1.24.0` fell through while `cleanVersion` was already written to strip the prefix.
**Fix:** the patterns accept an optional `v`, and `cleanVersion` strips it.
**Test:** `test/core/knowledge/component.test.ts` (“strips a leading v from the version”).
**Related:** `RISK-RELEASE-01`.

### RISK-MCP-01 — MCP tools bypassed the default ask and their failures were unaudited

**Status:** fixed 2026-10-22 · **Severity:** critical · **Verified:** 2026-10-22
**Evidence (pre-fix):** `packages/axiomsec/src/session/prompt.ts` asked with `permission: "mcp:" + key`, while the default rule is `{ permission: "mcp", pattern: "*" }`. `Wildcard.match("mcp:echo_echo", "mcp")` is false, so the catch-all `"*": allow` won and the MCP tool executed without a prompt. A real local MCP fixture confirmed it. The same block appended `tool.called` but no `tool.error`, so a denied/failed MCP call vanished from the audit trail.
**Fix:** the permission is `mcp` with the server/tool key as the pattern; a deny rule still wins. The ask and execute are wrapped in `Effect.exit`; failures append `tool.error` before the failure propagates.
**Test:** `test/e2e/mcp.test.ts` (ask, deny, allow and ledger cases) using `test/fixtures/mcp-echo.ts`.
**Related:** `SEC-03`, `ENG-04`, `RISK-AUDIT-02`, `RISK-AUDIT-06`.

### RISK-PERM-09 — `autonomy` could elevate the session without approval

**Status:** fixed 2026-10-22 · **Severity:** critical · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/tools/autonomy.ts` writes a session-wide wildcard `allow` ruleset, but its `ctx.ask({ permission: "autonomy" })` resolved through the catch-all `"*": allow` because no `autonomy` default existed. A model could set `auto`, then run `bash` or other ask-level tools without a prompt for the rest of the session.
**Fix:** `packages/axiomsec/src/agent/agent.ts` defaults `autonomy: "ask"`.
**Test:** `test/security/tools-surface.test.ts` (approval and kernel fact) and `test/e2e/agent-advanced.test.ts` (“the model cannot self-elevate autonomy without approval”).
**Related:** `SEC-03`, `RISK-PERM-07`, `RISK-PERM-10`.

### RISK-PERM-10 — Adapter-backed triage tools defaulted to allow

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `binary_triage`, `iac_triage`, `cloud_posture` and `container_surface` call `ctx.ask`, but their permission keys were absent from `packages/axiomsec/src/agent/agent.ts`; the catch-all allow made those asks decorative. The latter two can read cloud credentials or pull container images.
**Fix:** all four keys default to `ask`; unavailable adapters still return a visible “Required adapter … not installed” result before any prompt.
**Test:** `test/security/tools-surface.test.ts` (agent ruleset and missing-adapter cases).
**Related:** `SEC-03`, `ENG-03`, `RISK-PERM-04`.

### RISK-AUDIT-05 — Argument-validation failures produced no ledger event

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/tools/tool.ts` parsed arguments before writing `tool.called`; when Zod rejected a call, the wrapper returned the error to the model with no `cyber_ledger` row at all. A model could probe malformed plugin/tool inputs invisibly.
**Fix:** the attempt is ledgered before validation (with redacted args); a validation failure appends `tool.error` with `reason: invalid arguments`.
**Test:** `test/e2e/plugin.test.ts` (“invalid plugin arguments are rejected before execution”).
**Related:** `ENG-04`, `SEC-06`, `RISK-AUDIT-04`.

### RISK-AUDIT-06 — MCP failures were not ledgered

**Status:** fixed 2026-10-22 · **Severity:** medium · **Verified:** 2026-10-22
**Evidence:** the MCP branch in `packages/axiomsec/src/session/prompt.ts` recorded `tool.called` and only the success path; a permission deny or `callTool` error ended the effect without `tool.error`.
**Fix:** the MCP ask + execute is captured with `Effect.exit`; failures append `tool.error` and then rethrow.
**Test:** `test/e2e/mcp.test.ts` deny and ask cases.
**Related:** `ENG-07`, `RISK-MCP-01`, `RISK-AUDIT-02`.

### RISK-SCOPE-09 — `dir-fuzz` ignored the boundary for every fuzzed path

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/scanners/dir-fuzzer.ts` used bare `fetch` for the baseline and every word. The scanner checked only the target URL, so a path-scoped operation could be probed at any path on the same origin.
**Fix:** the scanner passes its `allowUrl` callback; the baseline and every word are refused before the request. Blocked paths are counted separately.
**Test:** `test/core/scanner/scanners.test.ts` (baseline and words go through the callback; redirects are not followed).
**Related:** `SEC-01`, `SEC-02`, `RISK-SCOPE-05`.

### RISK-SCOPE-10 — `appsec_probe` checked only the origin, not each synthetic route

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/tools/appsec-probe.ts` guarded the target origin, then its probe plan fetched `/login`, IDOR and CORS paths with bare `fetch` and `redirect: "manual"`. A path-scoped boundary was bypassed for those requests.
**Fix:** every planned request calls `Guard.checkUrl`; denied routes return `path outside operation boundary` without fetching.
**Test:** `test/security/network-boundary.test.ts` (“appsec probe per-route boundary”) narrows the canonical scope to `/allowed` and confirms `/login` is never requested.
**Related:** `SEC-01`, `SEC-02`, `RISK-SCOPE-05`, `RISK-SCOPE-09`.

### RISK-CLI-02 — Empty `session list --format json` emitted nothing

**Status:** fixed 2026-10-22 · **Severity:** low · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/cli/cmd/session.ts` returned early for zero sessions, so a machine consumer received an empty stream instead of a JSON array.
**Fix:** empty JSON output is `[]`.
**Test:** `test/security/serve-replay.test.ts` (delete the only session, then parse the next list).
**Related:** `RISK-CLI-01`.

### RISK-PERM-11 — Per-prompt tool toggles replaced the session ruleset

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/session/prompt.ts` replaced `session.permission` with the per-prompt tool toggles (`tools: { todowrite:false, task:false }`) whenever any toggle was supplied. A `task` subagent therefore lost the parent run’s `question`/`plan_exit` denies the moment TaskTool spawned it; a pentest subagent re-enabled `question` through its agent defaults and blocked the headless loop waiting for an answer that could never arrive.
**Fix:** prompt tool toggles are merged *before* the existing session ruleset, and session rules are last so an operator deny wins. TaskTool also carries the parent session’s deny rules into the new child session.
**Test:** `test/e2e/agent-advanced.test.ts` (“a subagent inherits the parent run's deny rules”) inspects the child tool surface and ledger.
**Related:** `SEC-03`, `RISK-PERM-09`, `RISK-SESSION-02`.

### RISK-SESSION-02 — Headless run ignored subagent permission asks

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/cli/cmd/run.ts` handled `permission.asked` only when `properties.sessionID === sessionID` (the parent). A `task` child session’s ask was never answered; the child waited forever and the run hung.
**Fix:** the run’s approval policy applies to every permission request raised in its process; without `--dangerously-skip-permissions` it auto-rejects, with the flag it approves once.
**Test:** `test/e2e/agent-advanced.test.ts` (“a subagent permission ask is rejected instead of hanging the headless run”).
**Related:** `RISK-PERM-03`, `RISK-PERM-11`, `RISK-SESSION-01`.

### RISK-SESSION-03 — Forked sessions lost their parent and permission policy

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/session/session.ts` `Session.fork` called `createNext` without `parentID` or `permission`. The `/session/:id/children` API could never find a fork, and a headless run resumed with `--fork` lost the parent run’s `question`/`plan_exit` denies, re-opening the hang path that `RISK-PERM-11` closed.
**Fix:** the fork now records `parentID: original session` and copies `original.permission`.
**Test:** `test/security/serve-replay.test.ts` authenticated session API case (fork parent, children listing, inherited deny).
**Related:** `SEC-03`, `RISK-PERM-11`, `RISK-SESSION-02`.

### RISK-SCOPE-11 — WebRTC and WebTransport bypassed the browser boundary

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/tools/browser.ts` guarded HTTP with `context.route` and WebSockets with `context.routeWebSocket`, but a page could construct `RTCPeerConnection` with a STUN URL or `WebTransport`; both use UDP/QUIC and never pass through Playwright routing. A page served from in-scope `127.0.0.1` sent two STUN datagrams to an out-of-scope listener on `127.0.0.2` during an end-to-end `browser` run.
**Fix:** the browser context installs an init script in every frame that denies `RTCPeerConnection`, `webkitRTCPeerConnection` and `WebTransport` with `NotAllowedError`; `browser.txt` states the limitation. Service-worker requests were checked separately and do pass through the context route.
**Test:** `test/security/network-boundary.test.ts` (“a WebRTC STUN request cannot leave the boundary”; observed 2 datagrams before the fix) and (“a service worker fetch cannot leave the boundary”).
**Related:** `SEC-02`, `RISK-SCOPE-05`, `RISK-SCOPE-06`, `RISK-SCOPE-09`, `RISK-SCOPE-10`.

### RISK-SCAN-01 — A quiet open port was reported closed and service mode never probed

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/scanners/port-scanner.ts` registered a connection-level `timeout` listener that resolved `open: false` before the in-connect banner listener could resolve `open: true`. Any service that waits for a request (every HTTP server) was therefore reported closed. `packages/axiomsec/src/scanners/service-prober.ts` had the same listener ordering, so its “no banner — send an active probe” branch never ran; the socket was destroyed and the port resolved to `null`.
**Reproduction (pre-fix):** `bun /tmp/probe-scan.ts` against a loopback HTTP listener printed `openPorts: []` after the 1 s timeout; `probeServices` returned no service.
**Fix:** both probes settle once, track whether `connect` fired, and treat a post-connect timeout as an open port with no banner. The service prober now sends its HTTP probe on the first timeout and only reports `filtered` if that answer also times out.
**Test:** `test/core/scanner/scanners.test.ts` (“a TCP listener that sends no banner is still reported open”, “service mode sends an active probe to an HTTP listener”) and `test/security/network-boundary.test.ts` (“a loopback listener is found and identified”).
**Related:** `RISK-TOOL-01`, `V-S3`.

### RISK-SECRET-07 — Stored provider credentials were exported to model-spawned subprocesses

**Status:** fixed 2026-10-22 · **Severity:** high · **Verified:** 2026-10-22
**Evidence:** `packages/axiomsec/src/providers/provider.ts` copied an API auth key into `process.env` (`AWS_BEARER_TOKEN_BEDROCK`, `AICORE_SERVICE_KEY`) so the provider SDK could read it. Every child-process boundary then copied the whole environment: the `bash` tool (`tools/bash.ts` `shellEnv`), local MCP servers (`mcp/mcp.ts` `StdioClientTransport`), the PTY (`terminal/service.ts`), and `support/process.ts` spawn. With a canary written to `auth.json` as `sap-ai-core`, a scripted model ran `printenv AICORE_SERVICE_KEY` and received the canary; the credential was also available to third-party MCP server code.
**Fix:** `support/auth-env.ts` records which names AxiomSec itself injected and `withoutAuthEnv` removes only those from a child environment. The four spawn boundaries use it; an operator's own environment variable and an explicit plugin `shell.env` value are preserved, and provider SDKs still see `process.env`.
**Test:** `test/e2e/agent-advanced.test.ts` (“a stored provider key is not exported to the bash tool”; observed red before the fix) and `test/e2e/mcp.test.ts` (“a stored provider key is not exported to the MCP server”).
**Related:** `SEC-06`, `RISK-SECRET-02`, `RISK-SECRET-05`.

## Low

### RISK-DOC-01 — README/CHANGELOG advertise `/initialize`; the command is `/init`

**Status:** fixed 2026-10-21 · **Severity:** low · **Verified:** 2026-10-21
**Evidence (pre-fix):** `README.md:100,171` and `CHANGELOG.md:44` described `/initialize`; `packages/axiomsec/src/commands/command.ts:70` defines `INIT: "init"` and `:181-190` registers “guided AGENTS.md setup”; `packages/axiomsec/src/commands/template/initialize.txt:1` says “Create or update AGENTS.md”.
**Why it matters:** An agent following the README could run `/init` expecting an operation scaffold and instead rewrite the root `AGENTS.md` harness.
**Fix:** `README.md:100,171` now documents `/init` as the AGENTS.md harness writer and points to `/pwn` or `operation new` for operations. Historical CHANGELOG release notes are left unchanged so the record stays accurate.
**Re-verify:** `rg -n "/initialize" README.md` (expect no current-command matches); `sed -n '69,71p;181,190p' packages/axiomsec/src/commands/command.ts`.
**Safe check:** Read-only. Do not run `/init` at repo root.
**Related:** `AGENTS.md` danger zone, `VERIFICATION.md`.

### RISK-DOC-02 — README tool list is a subset; registry keys differ from tool ids

**Status:** fixed 2026-10-21 · **Severity:** low · **Verified:** 2026-10-21
**Evidence (pre-fix):** `README.md:183-194` listed a marketing subset; `packages/axiomsec/src/tools/registry.ts:236-336` shows registry keys (`fetch`, `todo`, `search`, `code`, `patch`, `httprequest`) that differ from tool ids (`webfetch`, `todowrite`, `websearch`, `codesearch`, `apply_patch`, `http_request`); `question`/`plan` are conditional.
**Why it matters:** Agents grep for the wrong name or assume a tool is always visible.
**Fix:** The README tool-surface section now states that tool ids are model-facing and `registry.ts` is the source of truth, calls out key/id differences, and lists conditional tools (`question`, `plan`, `task`, MCP/plugin).
**Re-verify:** read the README tool-surface section; compare with `packages/axiomsec/src/tools/registry.ts:236-336`.
**Safe check:** Read-only.
**Related:** `ARCHITECTURE.md` §7.

### RISK-LINT-01 — Lint/format configuration is inconsistent

**Status:** fixed 2026-10-21 · **Severity:** low · **Verified:** 2026-10-22
**Evidence (pre-fix):** `.oxlintrc.json:3-5,44-49` had duplicate `options` keys; Prettier config at `package.json:101-104` is unenforced (no format script/CI); `.editorconfig:9` set 80 columns while Prettier uses 120.
**Why it matters:** Agents can “fix” formatting in unrelated files or trust a lint pass that ignores formatting.
**Fix:** `.oxlintrc.json` now has one `options` block; `.editorconfig` uses 120 columns. The 2026-10-22 hardening pass excluded `packages/sdk/src/v2/gen/**` (generated) from lint, fixed high-signal findings in retained files (unhandled post-transaction promises, unsafe header spreads, `eval` in debug params, object stringification), and reverted unrelated autofix churn. Prettier remains intentionally unenforced (no format script or CI gate), documented here rather than silently assumed.
**Residual:** `bun run lint` reports 832 warnings and 0 errors (down from 990); remaining warnings are mostly `no-unsafe-type-assertion` and `consistent-return` style findings. Do not mass-format unrelated files.
**Re-verify:** `sed -n '1,20p' .oxlintrc.json`; `sed -n '9p' .editorconfig`; `bun run lint`.
**Safe check:** Read-only; run `bun run lint` if needed.
**Related:** `ENG-05`, `V-S8`.

### RISK-CI-01 — CI lacks tests, format, and security checks

**Status:** fixed 2026-10-23 · **Severity:** low · **Verified:** 2026-10-23
**Evidence (pre-fix):** `.github/workflows/ci.yml` ran typecheck, lint, and a single-platform build only.
**Fix:** CI now has one `validate` job: install, dependency audit, typecheck, lint, a single-platform build, then `bun test --timeout 60000` against that artifact. The audit gate fails when `bun audit --json` returns any advisory. Release validation builds with the pinned `AXIOMSEC_VERSION` and runs the same suite.
**Residual:** no OS matrix for pull requests, and Prettier remains intentionally unenforced; browser and live-provider tests skip when Chromium or keys are absent.
**Re-verify:** `sed -n '1,60p' .github/workflows/ci.yml`.
**Related:** `VERIFICATION.md`, `RISK-RELEASE-01`.

### RISK-TUI-01 — TUI idle animation could starve input

**Status:** fixed 2026-10-23 · **Severity:** low · **Verified:** 2026-10-23
**Evidence (pre-fix):** `packages/axiomsec/src/cli/cmd/tui/component/logo.tsx` ran an unconditional 16 ms ambient animation timer. Under OpenTUI 0.6 the ~37 ms frame cost saturated the event loop; the marker-based PTY probe measured 34 ms baseline input latency and the old probe up to 100 ms.
**Fix:** the logo uses a dynamic timer: 60 fps during intro/pointer interaction, 20 fps for ambient effects, and keypresses request an immediate render. Marker-based input latency is 24.5 ms (median of three runs), idle CPU 107 % vs 127 %, TUI RSS 523 vs 624 MB.
**Residual:** TUI behavior is not covered by `bun test`; the PTY probe and manual `V-S*` scenarios remain the gate.
**Re-verify:** `bun script/bench.ts tui` with `BENCH_TUI_KEY=zzqx`.
**Related:** `docs/performance/README.md`, `VERIFICATION.md`.

### RISK-ACP-01 — ACP 2 write path has no automated protocol test

**Status:** open · **Severity:** medium · **Verified:** 2026-10-23
**Evidence:** `packages/axiomsec/src/acp/agent.ts:159-173` registers the ACP 2 app handlers. `bun test` does not drive `session/new`, `session/prompt`, or a permission round-trip; only `initialize` was smoke-tested through the compiled binary, including the advertised `fork`/`list`/`resume` capabilities.
**Residual:** handlers reuse the existing session manager and typecheck, but a wire-level regression (renamed field, capability mismatch, handler dispatch) would not be caught by the suite.
**Re-verify:** drive `axiomsec acp` with an ACP client: initialize, session/new, session/prompt against the mock provider, and assert streamed updates and stop reasons.
**Related:** `VERIFICATION.md`, `RISK-CI-01`.

### RISK-DEP-01 — Drizzle 1.0 has no stable release

**Status:** open · **Severity:** low · **Verified:** 2026-10-23
**Evidence:** the root catalog pins `drizzle-orm`/`drizzle-kit` to `1.0.0-beta.22`. npm `latest` is 0.45.4, which cannot express the schema's unnamed columns; the newer 1.0 RC.5 removes `SQLiteTransaction` and weakens row inference (13 type errors), so beta.22 is the newest tagged, compatible release.
**Residual:** beta.22 may change before 1.0 stable; re-check typecheck and the migration suite on every Drizzle release.
**Re-verify:** `bun pm ls | grep drizzle` and `bun typecheck` after a bump.
**Related:** `docs/performance/README.md`.

### RISK-CLI-03 — An unknown command printed an error but exited 0

**Status:** fixed 2026-10-23 · **Severity:** low · **Verified:** 2026-10-23
**Evidence (pre-fix):** a bare argument is the default command's `[project]` positional. `packages/axiomsec/src/cli/cmd/tui/thread.ts:126-130` caught a failed `chdir`, printed "Failed to change directory", and returned without setting an exit status, so `axiomsec frobnicate` exited 0.
**Fix:** the catch sets `process.exitCode = 1` (`thread.ts:129`).
**Residual:** a bare argument that names an existing directory still starts the TUI by design; only the failed-directory path is asserted.
**Re-verify:** run `axiomsec frobnicate` from a directory that has no `frobnicate` child; expect exit 1. Regression: `packages/axiomsec/test/security/cli-surface.test.ts` — "an unknown command reports a failure instead of exiting 0 (RISK-CLI-03)".
**Related:** `VERIFICATION.md`.

### RISK-CLI-04 — `debug rg files --query` ignored its filter

**Status:** fixed 2026-10-23 · **Severity:** low · **Verified:** 2026-10-23
**Evidence (pre-fix):** `packages/axiomsec/src/cli/cmd/debug/ripgrep.ts:50-68` declared `--query` ("Filter files by query") but passed only `glob` to `Ripgrep.files` and printed the unfiltered stream.
**Fix:** the collected paths are filtered case-insensitively by `query` before `--limit` is applied (`ripgrep.ts:63-66`).
**Residual:** the filter is a substring match, not a fuzzy rank; that matches the option's wording.
**Re-verify:** create two files, run `axiomsec debug rg files --query <one-name>`, and confirm only the matching path prints. Regression: `packages/axiomsec/test/security/cli-surface.test.ts` — "debug rg files honours --query and --limit (RISK-CLI-04)".
**Related:** `VERIFICATION.md`.

### RISK-CLI-05 — `models <unknown-provider>` exited 0 after printing an error

**Status:** fixed 2026-10-23 · **Severity:** low · **Verified:** 2026-10-23
**Evidence (pre-fix):** `packages/axiomsec/src/cli/cmd/models.ts:61-64` reported "Provider not found" through `UI.error` and returned from the effect without setting an exit status, so scripts could not distinguish an empty result from a bad provider.
**Fix:** the branch sets `process.exitCode = 1` (`models.ts:64`).
**Residual:** none known.
**Re-verify:** `axiomsec models nosuch; echo $?` returns 1. Regression: `packages/axiomsec/test/security/cli-surface.test.ts` — "models rejects an unknown provider with a non-zero exit (RISK-CLI-05)".
**Related:** `VERIFICATION.md`.

### RISK-CLI-06 — A missing session on `run --session` produced an unhandled rejection and exit 0

**Status:** fixed 2026-10-23 · **Severity:** medium · **Verified:** 2026-10-23
**Evidence (pre-fix):** the prompt route in `packages/axiomsec/src/server/instance/session.ts` set status 200 and started a stream before resolving the session, so a missing session rejected inside the already-committed stream. Separately, `packages/axiomsec/src/cli/cmd/run.ts` ignored the SDK's `{ error }` result, so the CLI recorded no session error and exited 0 while Bun printed the rejection and a bundled-source excerpt to stderr.
**Fix:** the route resolves the session before committing the stream (`session.ts:820-825`), returning the documented 404; `run.ts:682,692` now converts a prompt/command error payload into an error event, and `run.ts:694-707` sets the run error and exit status, suppressing a duplicate when the session loop already reported the same text. The headless CLI therefore exits 1 with `Session not found: <id>` (or `Command not found: "<name>"`).
**Residual:** post-200 failures inside a valid session still surface through `session.error` events rather than the HTTP status, because the response is already streaming.
**Re-verify:** `axiomsec run hi --session ses_doesnotexist --format json`; expect exit 1, an `error` event with "Session not found", no `B:/~BUN` dump. Regression: `packages/axiomsec/test/e2e/agent-lifecycle.test.ts` — "an unknown --session fails the run cleanly (RISK-CLI-06)".
**Related:** `VERIFICATION.md`, `RISK-CI-01`.

## Leads (not verified)

These are suspicions from code reading, not confirmed facts. Do not cite them as bugs until reproduced.

- **Browser DNS prefetch/preconnect** — HTTP, WebSocket, WebRTC and WebTransport egress are covered and service-worker fetches pass through the route guard. DNS prefetch/preconnect can still contact a host without an HTTP request; confirm with a loopback DNS fixture before claiming complete browser egress coverage.
- **Triage adapter file scope** — `binary_triage` and `iac_triage` now gate user paths, but `cloud_posture` and `container_surface` may read provider/container configuration outside the workspace without an equivalent `external_directory`/`read` gate. Confirm with a canary config path.
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
