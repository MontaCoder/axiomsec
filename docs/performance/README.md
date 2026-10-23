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
- **CLI startup.** `--help` still imports all 22 command graphs (~391 ms) and
  `serve` takes ~442 ms. Loading only the invoked command's module (and all
  modules for `--help`) is the next candidate.
- **Snapshot cost per mutation.** `Tool.wrap` rebuilds the context pack by
  reading up to 1 MB from each projection file after every state-changing
  call. The read is bounded (`RISK-PERF-01`), but an incrementally maintained
  snapshot would remove it from the tool latency path.
- **TUI resident set.** ~355 MB with animations off is dominated by the
  worker, native scene buffers and the ~500 renderables on the home screen;
  collapsing static logo cells into style runs would also lower it.

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
paint and input but not every dialog.
