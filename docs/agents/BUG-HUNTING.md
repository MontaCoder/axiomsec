# AxiomSec Bug-Hunting Playbook

Read when: proactively auditing or triaging a suspected security/engineering defect.
**Authorized, local, read-only first.**

This file is about finding and proving bugs. Current confirmed issues live in [KNOWN-RISKS.md](KNOWN-RISKS.md); rules live in [INVARIANTS.md](INVARIANTS.md). Do not duplicate evidence here — reference risk IDs.

## 0. Authorization and method

- Use loopback fixtures, disposable workspaces/operations, and canary secrets.
- No active scanning of public targets, no exploit payloads, no third-party data.
- The goal is evidence, not a trophy. A code smell without a reproduction is a **lead**, not a finding.
- If a check could damage state or contact a third party, stop and use a static read instead.

## 1. The seven-step audit loop

1. **Frame** — pick an invariant (`SEC-*`/`ENG-*`) and write the expected behavior in one sentence.
2. **Map** — list every code path that can violate it: tool, wrapper, server route, CLI, projection, background job.
3. **Reproduce** — minimal, deterministic, disposable (loopback operation or temp DB); record exact commands/env.
4. **Capture** — logs, SQLite row/query, ledger event ID, file paths, hashes.
5. **Isolate** — use [DEBUGGING.md](DEBUGGING.md) to identify the layer; prove it by bypassing the layer above.
6. **Fix** — smallest change that restores the invariant; no drive-by refactors.
7. **Prove** — rerun the original reproduction, add a negative case, run the automated gate, update [KNOWN-RISKS.md](KNOWN-RISKS.md).

## 2. Prioritized risk map

Audit in this order: highest blast radius first.

| Priority | Subsystem | Audit question | Risk IDs | Proof |
|---|---|---|---|---|
| 1 | Scope/opsec | Does every egress path check the boundary before I/O? Is `ask` treated as an approval? | `RISK-SCOPE-01`, `RISK-SCOPE-02` | `V-S3` |
| 2 | Permissions | Do sensitive tools call `ctx.ask`? Do defaults silently allow them? | `RISK-PERM-01`, `RISK-PERM-02`, `RISK-PERM-03` | `V-S3` |
| 3 | Proof | Can a finding become reportable without real evidence/replay? Is replay signed? | `RISK-PROOF-01`, `RISK-PROOF-02` | `V-S4`, `V-S7` |
| 4 | Secrets/egress | Can headers/cookies/API keys leak into ledger, evidence, share, or logs? | `RISK-SECRET-01`, `RISK-SECRET-02` | `V-S6` |
| 5 | Persistence/concurrency | Can concurrent writers, slug collisions, or migration failures corrupt state? | `RISK-PERSIST-01`, `RISK-PERSIST-02`, `RISK-PERSIST-03` | `V-S2`, `V-S4` |
| 6 | Timeouts/cancellation | Can any network/subprocess call hang the loop? | `RISK-TIME-01` | `V-S8` |
| 7 | Build/release/generated | Can a green build/release hide a broken artifact or missing file? | `RISK-BUILD-01`, `RISK-BUILD-02`, `RISK-BUILD-03`, `RISK-CI-02`, `RISK-RELEASE-01`, `RISK-RELEASE-02` | `V-S8` |
| 8 | Docs/lint | Does documentation send agents down the wrong path? | `RISK-DOC-01`, `RISK-DOC-02`, `RISK-LINT-01`, `RISK-CI-01` | `V-S1` |

## 3. Command bank

Run from the repo root. These are read-only.

```bash
# Guard coverage vs the egress surface
rg -n "Guard\.(check|checkUrl|checkHost|checkPath)" packages/axiomsec/src/tools
rg -n "fetch\(|spawn\(|spawnSync\(|Bun\.spawn|playwright|net\.connect|createConnection" packages/axiomsec/src/tools

# Permission asks vs write/network tools and defaults
rg -n '"\\*": "allow"|ctx\.ask|fromConfig\(' packages/axiomsec/src/agent packages/axiomsec/src/tools packages/axiomsec/src/permissions

# Proof path
rg -n "isReportableFinding|replay_present|evidence_refs|verifyFindingProof|signature" \
  packages/axiomsec/src/core/cyber packages/axiomsec/src/tools/finding.ts packages/axiomsec/src/cli/cmd/replay.ts

# Persistence and concurrency
rg -n "appendFile|writeFile|readFile|migrated|uniqueSlug" \
  packages/axiomsec/src/core/cyber packages/axiomsec/src/core/evidence packages/axiomsec/src/core/operation

# Timeouts and cancellation
rg -n "fetch\(|spawn\(|spawnSync\(|AbortSignal\.timeout|Effect\.timeout" packages/axiomsec/src packages/sdk/src

# Server/MCP exposure
rg -n "listen\(|SERVER_PASSWORD|AuthMiddleware|hostname|ignoreHTTPSErrors" \
  packages/axiomsec/src/server packages/axiomsec/src/cli packages/axiomsec/src/mcp packages/axiomsec/src/tools/browser.ts
```

SQL check for verified findings and their refs:

```bash
bun run --cwd packages/axiomsec dev -- db query \
  "select operation_slug, entity_key, status, evidence_refs from cyber_fact where entity_kind='finding' and fact_name='record' and status='verified'" \
  --format json
```

Then for each ref, confirm `.axiomsec/operation/<slug>/evidence/<ref>.*` exists and appears in `manifest.jsonl`. The oracle does not do this for you.

## 4. Subsystem checklists

### 4.1 Scope

- [ ] Every tool that can reach a target calls `Guard.check*` before DNS/socket/browser/subprocess.
- [ ] `browser`, `net`, and `bash` are treated as unguarded until proven otherwise.
- [ ] Guard `ask` becomes an actual human decision, not metadata or an auto-allowed tool ask.
- [ ] No active operation does not mean “safe”; check the actual behavior (`packages/axiomsec/src/core/boundary/guard.ts:89`).
- [ ] Strict opsec covers all egress, not only HTTP.
- [ ] Redirects, resolved IPs, and browser navigations are checked at the final destination (lead).

### 4.2 Permissions

- [ ] Every write/network/secret tool calls `ctx.ask` with the correct permission key.
- [ ] Built-in `"*": "allow"` does not silently allow the tool.
- [ ] `.env` protection is not only in the `read` tool (bash can read the same file).
- [ ] `debug agent` and `--dangerously-skip-permissions` are treated as test-only bypasses.
- [ ] Non-interactive `run` auto-rejects asks unless the dangerous flag is present.
- [ ] “Always” approvals are scoped as narrowly as possible.

### 4.3 Proof

- [ ] `kind`, `status`, `evidence_refs`, and replay/exemption satisfy `isReportableFinding`.
- [ ] Every evidence ref resolves to a manifest entry and a file; consider re-hashing.
- [ ] Replay is an actual artifact or a structured exemption with a valid category/rationale.
- [ ] Signature presence is not treated as verification (`replay verify` does not verify).
- [ ] Rejected/stale findings remain visible; report counts match the bucket logic.
- [ ] A fabricated evidence ref cannot make a finding reportable (`V-S4` negative case).

### 4.4 Secrets

- [ ] Vault file mode is 0600 and the storage is understood to be plaintext.
- [ ] `vault get --reveal` is gated or explicitly accepted as ungated.
- [ ] `vault set`/`identity add`/HTTP headers are not persisted in ledger args without redaction.
- [ ] Share redaction covers JSON/JSONL/HAR and structured headers, not just JWTs.
- [ ] `http_request` evidence does not store real headers/cookies/bodies.
- [ ] Server password and MCP OAuth callback bind are safe.

### 4.5 Persistence

- [ ] JSONL/manifest appends are atomic or locked; concurrent writers cannot duplicate/corrupt.
- [ ] Operation slugs are collision-proof; `create` does not clobber an existing directory.
- [ ] Migration failure is visible and retryable.
- [ ] DB rows and projections agree after a failure.
- [ ] Evidence refs and report manifests match the files on disk.

### 4.6 Build/release

- [ ] Release test gate runs when tests exist and is explicitly skipped otherwise (`RISK-RELEASE-01`).
- [ ] Referenced publish/generator files exist; no dead postinstall reference (`RISK-RELEASE-02`).
- [ ] `/tmp` is not used on Windows.
- [ ] Playwright optional imports remain externalized in the build (`RISK-BUILD-03`).
- [ ] SDK and models snapshot are regenerated, not hand-edited.
- [ ] Lint/format gaps are documented, not papered over.

## 5. Reproduction patterns

### 5.1 Loopback fixture

Use a tiny local server (Bun is available) and a disposable operation whose target is `http://127.0.0.1:PORT`. Never point a test at a public host.

```bash
bun -e 'Bun.serve({ hostname: "127.0.0.1", port: 18080, fetch(req) { return new Response("ok", { headers: { "content-type": "text/plain" } }) } }); console.log("fixture on 127.0.0.1:18080"); await new Promise(() => {})'
```

### 5.2 Disposable operation

```bash
TMP="$(mktemp -d)" && cd "$TMP" && git init -q
export XDG_DATA_HOME="$TMP/data" XDG_CONFIG_HOME="$TMP/config" XDG_CACHE_HOME="$TMP/cache" XDG_STATE_HOME="$TMP/state"
export AXIOMSEC_DB="$TMP/axiomsec.db" AXIOMSEC_DISABLE_MODELS_FETCH=1 AXIOMSEC_DISABLE_AUTOUPDATE=1
BIN="$(find /path/to/axiomsec/packages/axiomsec/dist -path '*/bin/axiomsec*' -type f | head -1)"
"$BIN" operation new "Audit" --kind pentest --target http://127.0.0.1:18080
```

### 5.3 Direct tool execution

`debug agent <agent> --tool <id> --params '<json>'` requires a default model and bypasses asks except explicit deny. Use only on a disposable workspace; for target tools, use loopback.

### 5.4 SQL assertions

Use `axiomsec db query "..." --format json` and inspect exact columns. Do not rely on the UI projection alone.

### 5.5 Replay tamper

Copy a disposable replay file, change one event line, and run `replay verify`; it should report a body SHA-256 mismatch. Then sign a file and confirm `verify` says signature verification is not implemented.

### 5.6 Share canary

Put `Authorization: Bearer canary-...` in a disposable evidence JSON/HAR and a ledger arg, build a share bundle with redaction on, and grep the tarball. No real secrets.

### 5.7 Concurrency

Run two local processes writing to a disposable evidence store or creating same-label operations in the same minute; inspect the manifest and directories. Never do this in a real workspace.

## 6. Reporting template

```text
Title:
Severity: critical | high | medium | low
Invariant: SEC-xx / ENG-xx
Expected:
Actual:
Evidence: file:line; command; output excerpt; DB row; artifact path
Minimal reproduction:
Blast radius:
Fix direction:
Risk ID: RISK-xxx-NN (new or existing)
```

Never include third-party target data, real credentials, or customer evidence. If the only proof requires them, stop and report the blocker.

## 7. Exit criteria

- Original reproduction no longer reproduces.
- A negative case still fails safely (e.g., fake evidence is rejected, out-of-scope traffic is denied).
- `bun typecheck`, `bun run lint`, and the single-platform build pass.
- Relevant `V-S*` scenario has evidence.
- `KNOWN-RISKS.md` is updated (fixed/stale/new) and any changed invariant doc is updated.
- No new module global, no hand-edited generated file, no new `/tmp`, no new bypass of `Guard`/`ctx.ask`.

Next: [VERIFICATION.md](VERIFICATION.md) for evidence requirements, [KNOWN-RISKS.md](KNOWN-RISKS.md) for the current register, [CHANGE-PLAYBOOKS.md](CHANGE-PLAYBOOKS.md) for the fix recipe.
