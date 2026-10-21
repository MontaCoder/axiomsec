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

**Pass:** slug/kind/target/active marker exist; `cyber/{ledger,facts,relations}.jsonl` exist; the context pack exists; the inferred scope includes `127.0.0.1`. **Evidence:** the JSON output and file list. Same-label operations are safe to create: three rapid creates must produce distinct slugs and preserve the first operation’s projections (`RISK-PERSIST-02` fixed 2026-10-21). Legacy migration: create `.axiomsec/operation/legacy-op/events.jsonl` before the first command; after `operation list`, `_legacy/events.jsonl` and a migrated `axiomsec.md` must exist (`RISK-PERSIST-03`).

### V-S3 — Tool wrapper, permissions, and scope (provider required for execution)

Static checks:

```bash
rg -n "Guard\.(check|checkUrl|checkHost|checkPath)" packages/axiomsec/src/tools
rg -n "ctx\.ask" packages/axiomsec/src/tools/{http-request,scanner,webfetch,browser,net,bash}.ts
```

Expected: Guard calls exist in `http-request`, `webfetch`, `scanner`, `appsec-probe`, `browser`, and `net`; `bash` has none (`RISK-SCOPE-03`).

With a configured default model:

```bash
"$BIN" debug agent security --tool scope --params '{"action":"status"}'
"$BIN" debug agent security --tool http_request --dangerously-skip-permissions --params '{"url":"http://127.0.0.1:18080/","method":"GET"}'
```

Scope enforcement checks (strict mode, loopback fixtures only):

```bash
"$BIN" debug agent security --tool scope --params '{"action":"set","level":"strict"}'
# expect "out of scope: host=127.0.0.2" before any connect
"$BIN" debug agent security --tool net --dangerously-skip-permissions --params '{"op":"tcp_send","host":"127.0.0.2","port":9,"timeout_ms":500}'
# start a local listener on 127.0.0.1:19090 first; expect the banner
"$BIN" debug agent security --tool net --dangerously-skip-permissions --params '{"op":"banner_grab","host":"127.0.0.1","port":19090,"timeout_ms":2000}'
# local page on 127.0.0.1:19091 embedding a 127.0.0.2:19092 subresource; expect the page to load
# and the 127.0.0.2 tracker to receive no browser request
"$BIN" debug agent security --tool browser --dangerously-skip-permissions --params '{"action":"navigate","url":"http://127.0.0.1:19091/"}'
# expect "out of scope: url=http://127.0.0.2:19092/"
"$BIN" debug agent security --tool browser --dangerously-skip-permissions --params '{"action":"navigate","url":"http://127.0.0.2:19092/"}'
```

If Playwright’s bundled Chromium revision is missing, set `AXIOMSEC_CHROMIUM_PATH` to an installed Chrome/Chromium binary. These checks were run on 2026-10-21 for `RISK-SCOPE-01`.

TLS check (loopback self-signed fixture): serve HTTPS with a generated certificate, then navigate without `ignore_https_errors` (expect `ERR_CERT_AUTHORITY_INVALID`) and with `"ignore_https_errors":true` (expect the page to load). Browser sessions are keyed by workspace + operation + TLS mode; switching keys closes the previous browser (`RISK-NET-01`).

**Pass:** scope status shows the active operation; the loopback request returns a status; `net` denies the out-of-scope host before connect and completes against the in-scope listener; `browser` loads the in-scope page, blocks the out-of-scope subresource, and denies the explicit out-of-scope URL; the TLS fixture fails by default and loads only with the opt-in; the ledger contains `tool.called`/`tool.completed`/`tool.error` as appropriate; evidence is written when an operation is active. A disposable `vault set` with a canary must leave zero canary occurrences in the ledger while `vault get --reveal` still returns it (`RISK-SECRET-02` partial); run it with `--dangerously-skip-permissions` because `vault` now defaults to ask. `debug agent` refuses ask-level tools unless `--dangerously-skip-permissions` is passed; with the flag it prints each bypass — record that in the evidence. **Negative check:** without the flag, `http_request`, `vault`, and `bash` must exit 1 with “resolves to ask”. With opsec `normal` and only `127.0.0.1` in scope, `net`/`http_request`/`browser` to `127.0.0.2` must exit 1 with “permission 'scope' resolves to ask”; in-scope traffic must not request `scope`. With the flag, the bypass is test-only and a boundary `ask` is not a human approval. **Evidence:** commands, outputs, tracker log, DB rows/ledger. Verified 2026-10-21 for `RISK-SCOPE-02` and `RISK-NET-01`.

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

**Pass:** a finding with real evidence + replay is `verified`/reportable; a finding with a fabricated 64-hex ref is rejected with `unresolved_evidence`, and `finding status` reports `found: false`; a stored artifact whose bytes no longer match its SHA is also rejected. **Evidence:** the evidence SHA, promotion output, finding status, report bundle path.

Negative checks (disposable operation only):

```bash
# fabricated ref — expect "Promotion rejected: evidence refs do not resolve"
FAKE="$(printf 'a%.0s' {1..64})"
"$BIN" debug agent security --tool finding --params "{\"action\":\"promote\",\"key\":\"fabricated\",\"evidence\":[\"$FAKE\"],\"replay\":\"canary\"}"

# tampered artifact — append bytes to a stored evidence file, then promote with its old SHA;
# expect rejection because Evidence.verify re-hashes the bytes
```

A rejected promotion must not create a finding fact (`finding status` → `found: false`). These cases were verified on 2026-10-21 for `RISK-PROOF-01`.

### V-S5 — Headless server and auth (no provider)

```bash
AXIOMSEC_SERVER_PASSWORD=canary "$BIN" serve --hostname 127.0.0.1 --port 4096 &
curl -s -u axiomsec:canary http://127.0.0.1:4096/config | head          # expect 200 + JSON
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4096/config   # expect 401
TOKEN="$(printf 'axiomsec:canary' | base64 -w0)"
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:4096/config?auth_token=$TOKEN"  # expect 401
kill %1
# non-loopback without a password must refuse before listening
env -u AXIOMSEC_SERVER_PASSWORD "$BIN" serve --hostname 0.0.0.0 --port 4097; echo "exit=$?"  # expect 1
```

Repeat the loopback start without `AXIOMSEC_SERVER_PASSWORD`; expect a warning and a 200. **Pass:** loopback bind, auth enforced when configured, URL tokens rejected, non-loopback without a password refused with exit 1, loopback without a password warns. **Do not** bind `0.0.0.0` with a password in this test. Verified 2026-10-21 for `RISK-NET-02` and `RISK-NET-03`.

### V-S6 — Share redaction canary (provider required, or module-level)

With a provider, add a canary evidence artifact containing `Authorization: Bearer canary-...`, then:

```bash
"$BIN" debug agent security --tool share --dangerously-skip-permissions --params '{"action":"build","redact":true}'
```

Locate the tarball from the output and inspect it:

```bash
tar -tzf .axiomsec/operation/<slug>/share-*.tar.gz | head
tar -xOzf .axiomsec/operation/<slug>/share-*.tar.gz | grep -n "canary-\|authorization\|cookie" || true
```

**Pass:** the bundle exists, `tar -xOzf ... | grep -n "canary-\|authorization\|cookie"` finds no canary **in a recognizable Authorization/Cookie or secret-key field**, redacted JSON remains parseable, and every file hash in the bundle's `manifest.json` matches the extracted file. A bare canary string with no key/header context is expected to survive; record it as `RISK-SECRET-03`, not a pass. Binary and extensionless artifacts are not content-scanned; never put real credentials in evidence. Build once with `redact:false` as a control and confirm the canary appears there. **Evidence:** both tarball paths, grep counts, manifest verification output. Verified 2026-10-21 for `RISK-SECRET-01` and `RISK-BUILD-04`.

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

**Pass:** `verify` reports `sha256: ok`; `show` renders the transcript. Signed trailers are verified when the matching public key is configured (`AXIOMSEC_MINISIGN_PUBKEY` or `COSIGN_PUBKEY`) and the tool is on PATH; a signed replay without a usable key prints `signature: <scheme> UNVERIFIED` and exits 1. Unsigned replays exit 0 with `signature: none`. **Evidence:** the verify output and file path. Verified 2026-10-21 for `RISK-PROOF-02`.

### V-S8 — Build and platform parity (no provider)

```bash
bun typecheck
bun run lint
bun run --cwd packages/axiomsec build --single --skip-install
"$BIN" --version
```

**Pass:** all exit 0; the produced binary prints a version. `"$BIN" generate | head -c 200` prints an OpenAPI 3.1 document; SDK regeneration is blocked on the missing generator config (`RISK-BUILD-02`). On Windows, `/tmp` paths are no longer expected in code (`RISK-BUILD-01` fixed 2026-10-21) and the Playwright optional-dependency failure is fixed (`RISK-BUILD-03`); do not treat a successful build as proof that `db generate` or replay signing works. If the build fails for an environment reason, record the exact command/output and do not claim a pass.

### V-S9 — Path containment (no provider)

Run from the repo root with a disposable temp directory:

```bash
bun -e '
import { AppFileSystem } from "./packages/shared/src/filesystem.ts"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const base = await mkdtemp(join(tmpdir(), "contain-"))
const parent = join(base, "parent"), outside = join(base, "outside")
await mkdir(parent); await mkdir(outside)
await writeFile(join(parent, "inside.txt"), "ok")
await writeFile(join(outside, "secret.txt"), "secret")
await symlink(outside, join(parent, "link"), "junction")
console.log("inside", AppFileSystem.contains(parent, join(parent, "inside.txt")))
console.log("outside", AppFileSystem.contains(parent, join(outside, "secret.txt")))
console.log("link", AppFileSystem.contains(parent, join(parent, "link", "secret.txt")))
console.log("missing", AppFileSystem.contains(parent, join(parent, "new", "file.txt")))
await rm(base, { recursive: true, force: true })
'
```

**Pass:** `inside true`, `outside false`, `link false`, `missing true`. On non-Windows, use `symlink(outside, link)` without the junction type. Verified 2026-10-21 for `RISK-PATH-01`.

### V-S10 — Evidence manifest concurrency (no provider)

Run from the repo root:

```bash
bun -e '
import { Flock } from "./packages/shared/src/util/flock.ts"
import * as Evidence from "./packages/axiomsec/src/core/evidence/store.ts"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const base = await mkdtemp(join(tmpdir(), "evidence-lock-"))
Flock.setGlobal({ state: join(base, "state") })
const ws = join(base, "ws")
await Promise.all(Array.from({ length: 8 }, () => Evidence.put(ws, "op", "same-canary", { ext: "txt" })))
const manifest = await readFile(join(ws, ".axiomsec", "operation", "op", "evidence", "manifest.jsonl"), "utf8")
console.log("manifest lines:", manifest.trim().split("\n").filter(Boolean).length)
await rm(base, { recursive: true, force: true })
'
```

**Pass:** exactly `1` manifest line for the shared content. An unlocked control run without `Flock.setGlobal` may produce duplicates. Verified 2026-10-21 for `RISK-PERSIST-01`.

### V-S11 — Agent loop with a local mock provider (no external credentials)

1. Start an OpenAI-compatible SSE server on `127.0.0.1:19099` that returns one text chunk (`MOCK-PROVIDER-OK`) and a `finish_reason: "stop"` chunk with `usage`.
2. In a disposable workspace, configure:
   ```json
   {
     "model": "mock/mock-model",
     "provider": {
       "mock": {
         "id": "mock", "name": "Mock", "env": ["MOCK_API_KEY"],
         "npm": "@ai-sdk/openai-compatible",
         "options": { "baseURL": "http://127.0.0.1:19099/v1", "apiKey": "mock" },
         "models": { "mock-model": { "name": "Mock", "tool_call": true, "limit": { "context": 8192, "output": 1024 }, "cost": { "input": 0, "output": 0 } } }
       }
     }
   }
   ```
3. Run with `MOCK_API_KEY=mock "$BIN" run "Say MOCK-PROVIDER-OK" --format json`.

**Pass:** a `text` event contains `MOCK-PROVIDER-OK`, a `step_finish` reports usage, the command exits 0, and stdout contains no `"type":"error"` event. Repeat in a workspace with more than 100 changed paths to exercise the snapshot batching (`RISK-SNAPSHOT-01`). Verified 2026-10-21.

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
- Do not use `--dangerously-skip-permissions`, `debug agent` bypasses, or `run --dangerously-skip-permissions` on a real target.
- Do not hand-edit generated files.
- Do not add test files in an ordinary PR; propose a test harness as a separate repo-structure change (it requires `.gitignore`, `bunfig.toml`, and CI changes).
- Do not reformat unrelated files.
- Do not hide a known risk by deleting it from the register; mark it fixed/stale with evidence.

Next: [CHANGE-PLAYBOOKS.md](CHANGE-PLAYBOOKS.md) for the recipe that applies, [DEBUGGING.md](DEBUGGING.md) for isolating a failure, [KNOWN-RISKS.md](KNOWN-RISKS.md) for current gaps.
