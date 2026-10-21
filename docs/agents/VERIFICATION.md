# AxiomSec Verification

Read when: proving a change.
This file is the definition of done.

## 1. The test situation

| Command | What it actually does | Can you trust it? |
|---|---|---|
| `bun test` (root) | Prints “tests are not shipped in this lite repo” and exits 0 (`package.json:12`) | No |
| `bun test --timeout 30000` in `packages/axiomsec` | The release workflow runs it only when test files exist (`.github/workflows/release.yml`); tests are gitignored (`.gitignore:35-47`) and `bunfig.toml:4-5` redirects the test root, so this lite repo skips it | No; no behavioral coverage |
| `bun typecheck` | Turbo + `tsgo --noEmit` across packages | Strongest automated signal |
| `bun run lint` | oxlint; duplicate `options` keys in `.oxlintrc.json`; no format check | Partial |
| `bun run --cwd packages/axiomsec build --single --skip-install` | Bun compile + embedded migrations + `--version` smoke | Build proof, not behavior proof |
| `bun install` | Exact lockfile resolution | Setup only |

There is no coverage, no test fixtures, and no CI test job. **Never write “tests pass.”**

## 2. Required gate

Run from the repo root:

```bash
bun install
bun typecheck
bun run lint
bun run --cwd packages/axiomsec build --single --skip-install
```

For CI parity, use `bun install --frozen-lockfile` when validating dependency changes and confirm `bun --version` matches the `packageManager` pin (1.3.11). A newer local Bun can change bundling behavior. The build must exit 0; the build script also runs the produced binary with `--version` on the current platform (`packages/axiomsec/script/build.ts`).

`bun run lint` may emit warnings. Read them; do not treat a warning-only run as clean if the warning is in your change.

## 3. Manual scenarios

Define `BIN` once after the build:

```bash
REPO="$(pwd)"
BIN="$(find "$REPO/packages/axiomsec/dist" -path '*/bin/axiomsec*' -type f | head -1)"
```

Use a disposable workspace and the isolation recipe from [DEBUGGING.md](DEBUGGING.md) for every scenario that writes state. The scenarios are listed by prerequisite.

### V-S1 — Offline boot and introspection (no provider)

```bash
TMP="$(mktemp -d)"; cd "$TMP"; git init -q
export XDG_DATA_HOME="$TMP/data" XDG_CONFIG_HOME="$TMP/config" XDG_CACHE_HOME="$TMP/cache" XDG_STATE_HOME="$TMP/state"
export AXIOMSEC_DB="$TMP/axiomsec.db" AXIOMSEC_TEST_HOME="$TMP/home"
export AXIOMSEC_DISABLE_MODELS_FETCH=1 AXIOMSEC_DISABLE_AUTOUPDATE=1 AXIOMSEC_DISABLE_CLAUDE_CODE=1
"$BIN" --version
"$BIN" debug paths
"$BIN" debug config > config.json
```

**Pass:** version prints; `debug paths` points under `$TMP`; `config.json` is valid JSON. **Evidence:** command, output excerpt, paths.

### V-S2 — Operation lifecycle and projections (no provider)

```bash
"$BIN" operation new "Verify" --kind pentest --target http://127.0.0.1:18080
"$BIN" operation list --format json
"$BIN" operation show --format json
cat .axiomsec/operation/active
ls .axiomsec/operation/verify/cyber .axiomsec/operation/verify/context
```

**Pass:** slug/kind/target/active marker exist; `cyber/{ledger,facts,relations}.jsonl` exist; the context pack exists; the inferred scope includes `127.0.0.1`. **Evidence:** the JSON output and file list. Do not create two same-label operations in the same minute in a real workspace (see `RISK-PERSIST-02`).

### V-S3 — Tool wrapper, permissions, and scope (provider required for execution)

Static checks:

```bash
rg -n "Guard\.(check|checkUrl|checkHost|checkPath)" packages/axiomsec/src/tools
rg -n "ctx\.ask" packages/axiomsec/src/tools/{http-request,scanner,webfetch,browser,net,bash}.ts
```

With a configured default model:

```bash
"$BIN" debug agent security --tool scope --params '{"action":"status"}'
"$BIN" debug agent security --tool http_request --params '{"url":"http://127.0.0.1:18080/","method":"GET"}'
```

**Pass:** scope status shows the active operation; the loopback request returns a status; the ledger contains `tool.called`/`tool.completed`; evidence is written when an operation is active. `debug agent` bypasses asks except explicit deny — note it in the evidence. **Negative check:** a request to a different loopback port is outside `in_scope`; the boundary returns `ask`, but the tool’s own ask is bypassed by `debug agent`. Record this as the known `RISK-SCOPE-02` behavior, not a pass. **Evidence:** command, output, DB rows/ledger.

### V-S4 — Evidence → finding → oracle → report (provider required for promotion)

Pure predicate check (no provider):

```bash
bun -e 'import { isReportableFinding } from "./packages/axiomsec/src/core/cyber/finding.ts"
const base = { kind: "finding", status: "verified", evidence_refs: ["deadbeef"], replay_present: false }
console.log("no replay:", isReportableFinding(base))
console.log("replay:", isReportableFinding({ ...base, replay_present: true }))
'
```

Full flow with a provider:

1. Add evidence: `debug agent security --tool evidence --params '{"action":"add_text","label":"canary","text":"canary-evidence"}'`.
2. Promote a finding using the returned SHA and a short replay string.
3. Inspect `finding status <key>` and `finding list`.
4. Build a report: `debug agent security --tool report --params '{"action":"build","format":"md"}'`.
5. Inspect `.axiomsec/operation/<slug>/deliverable/bundle-*/`.

**Pass:** a finding with real evidence + replay is `verified`/reportable; a finding with a fabricated 64-hex ref is also accepted today — record that as `RISK-PROOF-01`, not a pass. **Negative case:** fabricated evidence must be expected to fail after a fix. **Evidence:** the evidence SHA, finding status, report bundle path.

### V-S5 — Headless server and auth (no provider)

```bash
AXIOMSEC_SERVER_PASSWORD=canary "$BIN" serve --hostname 127.0.0.1 --port 4096 &
curl -s -u axiomsec:canary http://127.0.0.1:4096/config | head
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4096/config   # expect 401
kill %1
```

Repeat without `AXIOMSEC_SERVER_PASSWORD`; expect a warning and a 200. **Pass:** loopback bind, auth enforced when configured, unauthenticated warning when not. **Do not** bind `0.0.0.0`.

### V-S6 — Share redaction canary (provider required, or module-level)

With a provider, add a canary evidence artifact containing `Authorization: Bearer canary-...`, then:

```bash
"$BIN" debug agent security --tool share --params '{"action":"build","redact":true}'
```

Locate the tarball from the output and inspect it:

```bash
tar -tzf .axiomsec/operation/<slug>/share-*.tar.gz | head
tar -xOzf .axiomsec/operation/<slug>/share-*.tar.gz | grep -n "canary-\|authorization\|cookie" || true
```

**Pass:** the bundle exists and its manifest hashes match. **Important:** current redaction is JWT-only and limited to selected text extensions; finding the canary is a confirmed `RISK-SECRET-01`, not a test failure to hide. **Evidence:** tarball path, grep output, manifest entry.

### V-S7 — Replay save/show/verify (no provider)

Create a session through a loopback server, then export it:

```bash
"$BIN" serve --hostname 127.0.0.1 --port 4096 &
SID="$(curl -s -X POST http://127.0.0.1:4096/session -H 'content-type: application/json' -d '{}' | bun -e 'const j = await new Response(Bun.stdin.stream()).json(); console.log(j.id)')"
"$BIN" replay save "$SID" --out replay.axiomsec
"$BIN" replay verify replay.axiomsec
"$BIN" replay show replay.axiomsec | head
kill %1
```

**Pass:** `verify` reports `sha256: ok`; `show` renders the transcript. If the trailer is signed, `verify` says signature verification is not implemented (`RISK-PROOF-02`). **Evidence:** the verify output and file path.

### V-S8 — Build and platform parity (no provider)

```bash
bun typecheck
bun run lint
bun run --cwd packages/axiomsec build --single --skip-install
"$BIN" --version
```

**Pass:** all exit 0; the produced binary prints a version. On Windows, also inspect the `/tmp` risks (`RISK-BUILD-01`) and the Playwright optional-dependency failure (`RISK-BUILD-03`); do not treat a successful build as proof that `db generate` or replay signing works. If the build fails for an environment reason, record the exact command/output and do not claim a pass.

## 4. Clean-room recipe

Use the XDG + `AXIOMSEC_DB` recipe in [DEBUGGING.md](DEBUGGING.md). `AXIOMSEC_TEST_HOME` alone is not enough. Run `debug paths` and confirm every path is under the temp directory before creating operations.

## 5. Evidence format for a PR

Include:

- Command and working directory.
- Environment variables that mattered (never secrets).
- Output excerpt, not a screenshot unless the issue is TUI-only.
- `file:line` for the invariant or code path.
- SQLite query/result or artifact path (evidence, report, share, replay).
- Before/after behavior.
- Risk ID if the change touches a known risk.

## 6. Definition of done

A change is done only when:

- [ ] `bun typecheck` passes.
- [ ] `bun run lint` passes; warnings were read, not ignored.
- [ ] `bun run --cwd packages/axiomsec build --single --skip-install` passes, or the PR states exactly why it could not run.
- [ ] The relevant `V-S*` scenario was run, with command output or artifact paths in the PR.
- [ ] The change was checked against [INVARIANTS.md](INVARIANTS.md); any new or changed risk is in [KNOWN-RISKS.md](KNOWN-RISKS.md) with a date and `file:line`.
- [ ] If behavior, commands, generated files, or paths changed, the matching deep doc was updated in this PR.
- [ ] `AGENTS.md` remains ≤150 lines and its links resolve.

## 7. What not to do

- Do not claim tests pass. `bun test` is a no-op.
- Do not run the release workflow to “see if it works.”
- Do not use real credentials, customer data, or third-party targets.
- Do not use `--dangerously-skip-permissions` or `debug agent` on a real target.
- Do not hand-edit generated files.
- Do not add test files in an ordinary PR; propose a test harness as a separate repo-structure change (it requires `.gitignore`, `bunfig.toml`, and CI changes).
- Do not reformat unrelated files.
- Do not hide a known risk by deleting it from the register; mark it fixed/stale with evidence.

Next: [CHANGE-PLAYBOOKS.md](CHANGE-PLAYBOOKS.md) for the recipe that applies, [DEBUGGING.md](DEBUGGING.md) for isolating a failure, [KNOWN-RISKS.md](KNOWN-RISKS.md) for current gaps.
