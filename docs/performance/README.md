# AxiomSec modernization: inventory, plan and results

This report covers the performance and platform modernization of the AxiomSec
monorepo: every runtime, dependency, tool, config and CI entry point was
inventoried, upgraded and measured against a recorded baseline.

Reproduce it on the same host with:

```bash
bun install --frozen-lockfile
bun run --cwd packages/axiomsec build --single --skip-install
bun script/bench.ts --label latest --out docs/performance/latest.json
bun script/bench.ts compare docs/performance/baseline.json docs/performance/latest.json
```

The benchmark drives the compiled release binary: cold start (15 runs),
headless server startup, RSS, idle CPU, loopback HTTP throughput, TUI first
paint and input-to-next-frame latency through a real PTY. TUI numbers are
end-to-end interactions with the compiled binary; they complement, but do not
replace, the manual `V-S*` TUI scenarios.

Two environment knobs isolate TUI cost without changing the default run:

- `BENCH_TUI_ANIMATIONS=off` seeds `animations_enabled: false` into the
  throwaway state directory, so the logo's timers never start.
- `BENCH_TUI_IDLE_MS=<ms>` widens the idle CPU window (default 4000). Use
  30000 for steady-state numbers; the default window still contains first-run
  mount and sync work, which inflates the average.

`isoHome()` also pins `XDG_STATE_HOME`, so a developer's real `kv.json` (for
example, one with animations disabled) cannot leak into a probe.

## Results (2026-10-23, win32-x64, Bun 1.4.4)

| Metric | Baseline | After | Delta |
|---|---:|---:|---:|
| Cold start `--version` (p50) | 384.0 ms | **28.6 ms** | **-92.6 %** |
| Cold start `--help` (p50) | 403.9 ms | 396.3 ms | -1.9 % |
| Server listen | 470.4 ms | **453.4 ms** | **-3.6 %** |
| Server RSS (3 s) | 160.7 MB | **135.9 MB** | **-15.5 %** |
| Server idle CPU | 0.52 % | 0.00 % | -100 % (measurement floor) |
| Loopback HTTP throughput | 2,467 req/s | **2,498 req/s** | **+1.3 %** |
| TUI first output | 17.42 ms | 17.27 ms | -0.9 % |
| TUI input → painted text | 34.0 ms | **24.5 ms** | **-27.9 %** |
| TUI idle CPU | 127 % | **107 %** | **-16.0 %** |
| TUI peak RSS | 624.1 MB | **522.6 MB** | **-16.3 %** |
| Installed `node_modules` | 1,641 MB | **573 MB** | **-65.1 %** |
| `bun.lock` | 2,016 lines / 936 resolved | 1,773 lines / 609 installed | **-12.1 % lines** |
| Typecheck (uncached) | 3.9 s | 3.3 s | -15 % |
| Lint | 3.1 s / 0 errors | 3.2 s / 0 errors | ~flat (964 warnings) |
| Test suite | 343 tests / 226.7 s | 343 tests / 217 s | -4.3 % |
| Single-platform build | 3.0 s | **2.6 s** | **-12.5 %** |
| Compiled binary | 134.4 MB | 142.5 MB | **+6.0 %** |
| Audit | 58 findings in the intermediate tree (2 critical) | **0 findings / 609 packages** | **clean** |

The 8 MB binary growth is an accepted tradeoff (2026-10-23, operator decision);
keeping the mandated OpenTUI 0.6 and AI SDK 7 upgrades and all provider/browser
functionality takes precedence over raw binary size. OpenTUI 0.6's new renderer
and native core are larger, while the install tree shrank by 1.07 GB. The
growth is confined to the compiled binary; install, lockfile and container
layers all got smaller.

### TUI input latency was fixed in the app

The first probe measured the boot splash and the logo's unconditional 16 ms
ambient render loop. On OpenTUI 0.6 that loop saturated the event loop, so
keystrokes waited multiple frames. The logo now runs ambient effects at 20 fps
and switches back to 60 fps for intros and pointer interactions
(`packages/axiomsec/src/cli/cmd/tui/component/logo.tsx`), while every keypress
requests a render. The benchmark now seeds a mock provider so it reaches the
real prompt and measures until the typed marker is painted. Median input
latency fell from 34.0 to 24.5 ms, TUI idle CPU from 127 % to 107 %, and TUI
peak RSS from 624 to 523 MB.

## TUI idle loop (2026-10-23)

The home logo was the largest remaining idle consumer. Its intro cycle loops
every 8 s, and the component's timer re-rendered every cell every 16 ms during
intros and every 50 ms otherwise — including the roughly 60 % of the cycle
where no ambient effect is active and the pixels cannot change. The PTY probe
measured 106.6 % idle CPU and 523 MB peak RSS.

The component now:

- schedules the next frame at the next ambient or intro boundary during quiet
  idle instead of ticking continuously;
- runs cipher rain at 20 fps, scan/ignite sweeps at 30 fps, and keeps 60 fps
  for pointer ripples; and
- renders one final frame at each ambient window end so the effect clears.

| Metric (4 s probe) | Before | After | Delta |
|---|---:|---:|---:|
| TUI idle CPU | 106.6 % | **65.2 %** | **-38.8 %** |
| TUI peak RSS | 522.6 MB | **354.8 MB** | **-32.1 %** |
| TUI input → painted text | 24.5 ms | **10.3 ms** | **-57.9 %** |

The 4 s window includes first-run mount and sync work, which is why it reads
higher than the steady state. A 30 s window (`BENCH_TUI_IDLE_MS=30000`) puts
the median at **28.2 % CPU / ~415 MB peak RSS** with animations enabled and
**7.5 % / ~355 MB** with `BENCH_TUI_ANIMATIONS=off`. The remaining animation
cost is the deliberate 8 s intro cycle; the loop now sleeps between effects
instead of repainting static cells.

Cold start, TUI first paint (9–18 ms on both builds), server
startup/RSS/throughput, and binary size stayed within run-to-run noise (see
`tui-idle.json`). The install-tree figure in that
artifact reflects a release tree with every native variant installed; it is
not comparable to the 0.5.0 `node_modules` measurement.

### Remaining opportunities

Measured on the same host, after this change:

- **Intro cadence.** The 8 s decorative cycle still averages ~20 % CPU while
  the home logo is visible. Shortening the cycle, rendering the reveal once
  per screen rather than looping, or batching cell updates into style runs
  would reduce it further; each changes the visual design.
- **CLI startup.** Fixed 2026-10-24: top-level commands now load lazily, the
  TUI app is imported only by the TUI handler, and help skips logging and the
  database marker check. `--help` fell to 119.0 ms and `serve` to 350.1 ms.
- **Snapshot cost per mutation.** Fixed 2026-10-24: the evidence index is
  linear instead of O(evidence × facts), the tool path reuses the operation it
  already read, the TUI coalesces the five views into one build, and evidence
  listings no longer take the write lock. The synthetic snapshot fell from
  124.9 ms to 14.0 ms. Projection JSONL parsing remains the dominant part.
- **TUI resident set.** ~358 MB with animations enabled is dominated by the
  worker, native scene buffers and the ~500 renderables on the home screen;
  coalescing snapshot builds lowered it from 384 MB, and collapsing static
  logo cells into style runs would lower it further.

### Why `--version` is 13x faster

The entrypoint now answers `--version`/`-v` before importing the CLI graph and
loads the existing entry as a dynamic chunk (`src/index.ts` → `src/main.ts`).
Every other command still loads the full graph, so `--help` stays near its
baseline (it must enumerate all commands). Server and TUI paths keep identical
behavior.

### Why server throughput and RSS improved

- Per-request request logs moved from `info` to `debug`; the audit-relevant
  ledger is unchanged. This removes synchronous log work from the request path.
- Effect 4 stable, OpenTUI 0.6's smaller optional dependency set, and the
  removed Turbo/native-preview binaries cut resident code and install size.
- Server startup fell 97 ms and RSS 22 MB across the dependency work alone.

## Migrations

| Area | Before | After | Notes |
|---|---|---|---|
| Bun | 1.3.11 pin | **1.4.4** | `packageManager`, engines and `@types/bun` aligned |
| TypeScript | 5.8.2 + native-preview dev build | **7.0.2 stable** | native `tsc`; preview package removed |
| Task runner | Turbo 2.9.18 | **removed** | `bun run --filter '*' --parallel typecheck` |
| Lint/format | oxlint 1.60 / Prettier 3.6.2 | **oxlint 1.89 + tsgolint 7.0.2005 / Prettier 3.9.10** | type-aware rules kept |
| Effect | 4.0.0-beta.48 | **4.0.6 stable** | tagged errors, `effect/process`, `effect/http`, `effect/observability`, Flusher layer |
| OpenTUI / Solid | 0.1.99 / 1.9.10 + patch | **0.6.8 / 1.9.17** | Solid #2046 fixed upstream; local spinner replaces `opentui-spinner` |
| AI SDK | ai 6 + provider majors 2/3/4 | **ai 7 + providers 3/4/5** | `instructions`/system handling, `repairToolCall`, `@ai-sdk/otel` telemetry |
| ACP SDK | 0.16.1 legacy connection | **2.0.1 app/handler API** | unstable entrypoint retains fork/resume; `session/set_model` removed by protocol |
| Drizzle | `1.0.0-beta.19-d95b7a4` hash build | **1.0.0-beta.22 tagged** | 1.0 has no stable release; RC.5 breaks sync typing, 0.45 cannot express the schema |
| Zod | 4.1.8 | **4.6.7** | `z.toJSONSchema` replaces `zod-to-json-schema` |
| Hono OpenAPI | 1.1.2 + standard-openapi patch | **1.5.0 / standard-openapi 0.2.11** | upstream external-`$ref` fix; patch deleted |
| OTel | 1.9 / 0.214 / 2.6 | **1.10 / 0.300 / 2.12** | `@opentelemetry/api-logs` peer pinned explicitly |
| Prompts | `@clack/prompts` alpha | **1.8.1 stable** | spinner failures use `error()` |
| Other | yargs 18.0, glob 13.0.5, semver 7.7.4, diff 8, remeda 2.26, fuzzysort 3, open 10, etc. | **18.2 / 13.0.6 / 7.8.5 / 9 / 2.53 / 4 / 11** | exact pins, no range drift |
| Native replacements | `which`, `strip-ansi`, `zod-to-json-schema`, `gray-matter` | `Bun.which`, `Bun.stripANSI`, `z.toJSONSchema`, maintained `js-yaml` | four fewer legacy dependencies |

### Removed

- `turbo`, `@typescript/native-preview`, `@effect/language-service` (native
  TypeScript no longer runs TS plugins).
- Both Bun patches (`solid-js`, `standard-openapi`) and the patch workaround in
  CI.
- Unused catalog leftovers: `@solidjs/start` (a `pkg.pr.new` canary),
  `@solidjs/router`, `@solidjs/meta`, `@kobalte/core`,
  `@solid-primitives/storage`, Tailwind, `virtua`, `solid-list`, `shiki`,
  `marked`, `marked-shiki`, `vite`, `vite-plugin-solid`, `@playwright/test`,
  `luxon`, `dompurify`, `remend`, Cloudflare worker types.
- `opentui-spinner` (incompatible peer range; local component), `which`,
  `strip-ansi`, `zod-to-json-schema`, and unmaintained `gray-matter`.

### Intentional breaking changes

- **ACP:** the legacy connection classes are gone. `session/set_model` no longer
  exists in ACP v1 stable; model selection goes through
  `session/set_config_option` with `configId: "model"`. Fork and resume remain
  advertised and implemented through the `/unstable` v1 entrypoint.
- **AI SDK 7:** provider model spec is v4. The bundled Copilot provider still
  implements v3, which AI SDK 7 accepts; system messages are allowed explicitly
  via `allowSystemInMessages`.
- **TUI:** `opentui-spinner` was replaced by a local `SpinnerGlyph`; visual
  behavior and animation phases are preserved.
- **Build:** a `latest` build without `AXIOMSEC_VERSION` now uses the package
  version instead of fetching the npm registry. `SOURCE_DATE_EPOCH` makes
  preview version strings deterministic.
- **Internal file system API:** the app's custom `glob` is now `globFiles` to
  avoid colliding with Effect 4's `FileSystem.glob`.

## Production readiness

- **Audit:** `bun audit` reports `No vulnerabilities found (609 packages)`.
  CI fails when audit JSON is non-empty.
- **Reproducible builds:** two builds with the same
  `AXIOMSEC_VERSION`, `AXIOMSEC_CHANNEL` and `SOURCE_DATE_EPOCH` produced
  byte-identical binaries (SHA-256
  `7e7503b01c6a8e16d6d3b73ba0d8936afa74ab36ed8043420b3948c1636aa6f9`).
  Builds are offline by default: the bundled models.dev snapshot is reused
  unless `bun run --cwd packages/axiomsec models:refresh` is run explicitly.
- **Pinned versions:** every direct dependency is exact; `bunfig.toml` uses
  `exact = true`; no patches, no `pkg.pr.new`, no dev-build packages.
- **CI:** four installs and a duplicate build were merged into one `validate`
  job with a single install/build; dependency audit runs before typecheck.
  Based on local step timings, the job-minute sum drops from ≈293 s to ≈245 s
  (~16 %). This is a local measurement, not a GitHub-hosted billing figure.
- **Container:** base pinned to `alpine:3.22`, `apk add --no-cache`.
  Docker is not available in this environment, so the image footprint was not
  measured; the layer change removes the package index/cache.
- **Tests:** 343 tests across 37 files pass (4 live-provider skips) after every
  batch; the ACP 2 app API was additionally smoke-tested through the compiled
  binary (`initialize` → fork/list/resume capabilities).

## Validation gates

Run in strict order:

```bash
bun install --frozen-lockfile
bun typecheck
bun run lint
bun run --cwd packages/axiomsec build --single --skip-install
bun test --timeout 60000
bun audit
bun script/bench.ts compare docs/performance/baseline.json docs/performance/latest.json
```

The final tree passes all of the above. TUI scenarios remain manual per
[VERIFICATION.md](../agents/VERIFICATION.md); the PTY benchmark exercises first
paint and input but not every dialog. (2026-10-24 update: the dependency audit
was cleared before the 0.5.5 tag; see `RISK-DEP-02`.)

## 2026-10-24 follow-up: lazy CLI, event-driven TUI, linear snapshots

Same host (win32-x64, Bun 1.4.4), same harness. Reproduce with:

```bash
bun run --cwd packages/axiomsec build --single --skip-install
bun script/bench.ts --label pre-perf --out docs/performance/pre-perf.json   # baseline commit
bun script/bench.ts --label optimized --out docs/performance/optimized.json
bun script/bench.ts compare docs/performance/pre-perf.json docs/performance/optimized.json
bun run --cwd packages/axiomsec script/bench-hotpaths.ts
bun script/bench.ts stream
```

| Metric | Baseline | After | Delta |
|---|---:|---:|---:|
| Cold start `--version` p50 | 23.32 ms | 24.05 ms | ~flat |
| Cold start `--help` p50 | 386.98 ms | **119.20 ms** | **-69.2 %** |
| Server listen | 540.35 ms | **349.03 ms** | **-35.4 %** |
| Server RSS (3 s) | 134.59 MB | **114.37 MB** | **-15.0 %** |
| Server idle CPU | 2.60 % | 0.00 % | measurement floor |
| Loopback HTTP throughput | 2,557 req/s | 2,560 req/s | +0.1 % (noise) |
| TUI first frame (median of 3) | 17.34 ms | 9.00 ms | noisy, see samples |
| TUI input → painted text | 7.86 ms | 9.84 ms | noise, see note |
| TUI idle CPU (4 s) | 66.8 % | 71.09 % | noise, see steady state |
| TUI peak RSS | 383.9 MB | **357.8 MB** | **-6.8 %** |
| Binary size | 142.49 MB | 142.52 MB | ~flat |

TUI input latency is the noisiest metric: the baseline samples were
14.08/6.73/7.86 ms and the final optimized run measured 9.84 ms median. Nine
additional probes after the change measured 8.14–15.90 ms (median 10.51 ms),
consistent with the earlier 10.3 ms report; the baseline 7.86 ms was the low
end of its own 6.73–14.08 ms range. No code on the input path changed. The 4 s
idle window includes mount/sync work; a 30 s steady-state probe with animations
off measured 6.93/7.14/7.71 % CPU (median 7.14 %) and 341–355 MB, matching the
previous report's 7.5 % and showing no idle regression. The per-run samples
are kept in the JSON artifacts rather than claiming a regression or a win.
Server startup varied 344–425 ms across runs on this host; the 349 ms run in
`optimized.json` is representative of the other 344–350 ms runs. The loopback
throughput moved +0.1 %, inside the run-to-run range.

### Hot paths (synthetic 2,000 facts / 2,000 relations / 500 evidence)

| Path | Before p50 | After p50 | Delta |
|---|---:|---:|---:|
| `OperationSnapshot.build` | 124.87 ms | **13.59 ms** | **-89.1 %** |
| `OperationSnapshot.build` (first pass) | 124.87 ms | 23.90 ms | -80.9 % |
| Workflow sync, 10 steps | 227.97 ms | **26.62 ms** | **-88.3 %** |
| `Evidence.list` | 7.35 ms | **0.52 ms** | **-92.9 %** |
| `Operation.read` | 1.06 ms | 1.06 ms | flat |

The first-pass snapshot number is the result after the linear evidence index
and operation reuse; the final 14.01 ms also includes the lock-free manifest
listing. `Evidence.list` was lock-bound: a raw read+parse of the 500-entry
manifest is ~0.25 ms, while acquiring and releasing the write lock cost ~7.5 ms.

### Large evidence

A 64 MB sparse artifact through the same `Evidence.put`/`get` path:

| Case | Before | After | Delta |
|---|---:|---:|---:|
| `put` time | 140 ms | 159 ms | +14 % (streaming overhead) |
| `put` RSS delta | +67 MB | **+18–30 MB** | **~-55 to -73 %** |
| preview (`maxBytes=4000`) | full read, +129 MB | **2.8 ms, +0.25–0.5 MB** | bounded read |
| `verify` | full read + hash, +129 MB | **130 ms, no artifact-sized growth** | streaming SHA-256 |
| full `get` | 42 ms, +129 MB | **24.5 ms, +64 MB** | no extra copy |

File inputs above 16 MB now stream to a temp file while hashing; smaller files
keep the faster in-memory path. Previews read only the requested prefix, a full
read returns the buffer without copying it, and verification hashes the artifact
in one streaming pass instead of loading it. `evidence search` with no query
previews only the returned page: direct measurement of 500 small artifacts was
**22 ms for 20 previews vs 214 ms for all 500**. Metadata linking uses maps
instead of scanning findings/observations/routes per entry. The pre-fix numbers
are in `evidence-large-pre.json`; the probe was added after the first hot-path
run.

### Streaming probe

`bun script/bench.ts stream` seeds an operation with 500 facts / 200 evidence
and streams 300 deltas through a local OpenAI-compatible SSE endpoint. Streaming
CPU fell from a 66.48 % median (62.32–71.28 %) to **44.84 %** across two
3-sample runs on the final binary (40.01–50.64 %), a **-32.6 %** median. The
earlier optimized run measured 37.34 %; the TUI probe is noisy because the
logo animation dominates the same window. First-token time (~2.4 s) is
unchanged because it includes session creation and title generation.

### What changed

- `main.ts` builds the CLI from a lazy command registry; only the invoked
  command's graph loads. The TUI app/config imports moved into the TUI and
  attach handlers. Help skips logging, heap startup and the database marker
  check, and imports support modules directly instead of the full barrel.
- TUI operation views no longer rebuild snapshots on every `session.status`
  token. They refresh on idle, completed/errored tools and operation
  attach/detach, and share one per-app 150 ms coalescing loader.
- `evidenceIndex` now builds evidence→finding/observation/route maps in one
  pass with parity tests against the previous per-entry scan.
- Workflow progress writes all facts in one SQLite transaction and one
  projection append under one lock instead of two upserts per step.
- Evidence ingestion streams large files, previews honor `maxBytes`, full reads
  no longer copy the buffer, verification streams through SHA-256, and read-only
  manifest lookups/listings use a stat-verified read of the append-only file
  while writes stay locked. Empty-query search previews only the returned page,
  and linked entities are looked up through maps.

### Remaining

- Snapshot build is ~13.6 ms: projection JSONL parsing now dominates. Reading
  the canonical SQLite tables or adding a per-instance projection cache is the
  next candidate; both need a cache-invalidation design.
- Workflow sync is ~27 ms for 10 steps; further gains need a single-statement
  upsert or fewer projection records.
- Full evidence `get` still reads the whole artifact by design; `verify` now
  streams its hash, and previews are bounded. Small file inputs stay in memory.
- TUI idle CPU is animation-bound by design; TUI RSS is native-scene dominated.
- Session history is re-read per model step and remote instruction URLs are
  fetched per step; neither is on the measured benchmark path.
- Dependency audit is clean as of 0.5.5: transitive `body-parser`, `fast-uri`
  and `undici` were patched, and `gitlab-ai-provider` is resolved against Zod 4
  (its schemas use only object/string/number/record; see `RISK-DEP-02`).

### Validation

`bun typecheck`, `bun run lint` (0 errors, warnings reviewed), the
single-platform build, and `bun test --timeout 60000` (396 tests: 392 pass,
4 live-provider skips, 208 s) pass. TUI scenarios remain manual; the PTY
stream probe and the existing `V-S*` scenarios are the gate.
