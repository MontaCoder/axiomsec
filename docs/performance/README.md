# AxiomSec modernization: inventory, plan and results

This report covers the performance and platform modernization of the AxiomSec
monorepo. It starts from a measured baseline, lists every runtime, dependency,
tool and CI entry point, and records what changed and why.

Everything here is reproducible on the same host with:

```bash
bun run --cwd packages/axiomsec build --single --skip-install
bun script/bench.ts --label latest --out docs/performance/latest.json
bun script/bench.ts compare docs/performance/baseline.json docs/performance/latest.json
```

The benchmark measures a compiled release binary: cold start (20 runs),
headless server startup, RSS, idle CPU, loopback HTTP throughput, TUI first
paint and input-to-next-frame latency through a real PTY. TUI numbers are
end-to-end interactions with the compiled binary; they complement, but do not
replace, the manual `V-S*` TUI scenarios.

## Baseline (2026-10-23, win32-x64, Bun 1.4.4)

| Metric | Baseline |
|---|---:|
| Cold start `--version` (p50) | 389.5 ms |
| Cold start `--help` (p50) | 408.4 ms |
| Server listen | 549.8 ms |
| Server RSS (3 s) | 161.5 MB |
| Server idle CPU | 0.52 % |
| Loopback HTTP throughput | 2,337 req/s |
| TUI first output | 9.6 ms |
| TUI input → next frame | 392.5 ms |
| TUI peak RSS | 295.4 MB |
| Compiled binary | 134.4 MB |
| Installed `node_modules` | 1,641 MB |
| `bun.lock` | 2,016 lines / 936 resolved packages |
| Typecheck (uncached, Turbo) | 3.9 s |
| Lint | 3.1 s / 832 warnings |
| Test suite | 343 tests, 226.7 s |
| Single-platform build | 3.0 s |

## Runtime and toolchain inventory

| Area | Before | Latest stable | Action |
|---|---|---|---|
| Bun | 1.4.4 installed, `packageManager`/engines 1.3.11 | 1.4.4 | Align pins, engines and `@types/bun` |
| Node (CI publish) | 22 | 22 LTS is supported | Keep 22 for npm publish; app targets Bun |
| TypeScript | 5.8.2 + `@typescript/native-preview` dev build `20251207.1` | 7.0.2 (native) | Replace preview with TS 7 stable; one strictness fix |
| Type config | `@tsconfig/bun` 1.0.9, node22 22.0.2 | 1.0.11 / 22.0.6 | Bump |
| Lint | oxlint 1.60.0, oxlint-tsgolint 0.21.0, type-aware | 1.89.0 / 7.0.2005 | Upgrade, keep type-aware rules |
| Format | Prettier 3.6.2 | 3.9.10 | Upgrade |
| Task runner | Turbo 2.9.18 (only `typecheck`) | 2.11.10 | Remove; Bun workspaces run 4 packages faster than Turbo's install cost |
| Build | `Bun.build` with minify+splitting+compile | — | Skip all-platform installs for single-target builds |
| Tests | `bun test`, 343 tests in 37 files | — | Keep, validate every step |
| Container | floating `alpine`, no apk cache control | Alpine 3.22 | Pin tag, `apk add --no-cache` |

## Dependency inventory

| Package group | Before | Latest stable | Action |
|---|---|---|---|
| Effect | `4.0.0-beta.48` (effect, @effect/platform-node, @effect/opentelemetry) | 4.0.6 | Upgrade to stable |
| OpenTUI | `@opentui/core`/`solid` 0.1.99 | 0.6.8 | Upgrade; drops Jimp/Three/Planck/WebGPU/Yoga |
| Solid | 1.9.10 (patched) | 1.9.17 | Upgrade; patch fixed upstream (#2046) |
| Vite | 7.1.4 (catalog, unused) | 8.3.5 | Remove |
| Drizzle | `1.0.0-beta.19-d95b7a4` hash build | 0.45.4 stable (1.0 still RC) | Prefer stable 0.45 if the small query surface allows; otherwise tagged 1.0 RC + documented risk |
| Zod | 4.1.8 | 4.6.7 | Upgrade |
| AI SDK | `ai` 6.0.168 + provider majors 2/3/4 | `ai` 7.0.150 + providers 3/4/5 | Upgrade with codemod; `system`→`instructions`, `onFinish`→`onEnd` |
| ACP SDK | 0.16.1 | 2.0.1 | Major upgrade, verify ACP command |
| MCP SDK | 1.32.1 | 1.32.1 | Already latest |
| Hono / OpenAPI | hono 4.13.13, hono-openapi 1.1.2, standard-openapi 0.2.9 (patched) | 4.13.13 / 1.5.0 / 0.2.11 | Upgrade; upstream fixed external `$ref`, drop patch |
| CLI prompts | `@clack/prompts` 1.0.0-alpha.1 | 1.8.1 | Upgrade to stable |
| Yargs / glob / minimatch | 18.0.0 / 13.0.5 / 10.2.5 | 18.2.0 / 13.0.6 / 10.2.6 | Upgrade |
| semver / ulid / diff / remeda | 7.7.4 / 3.0.1 / 8.0.4 / 2.26.0 | 7.8.5 / 3.0.2 / 9.0.0 / 2.53.0 | Upgrade |
| fuzzysort | 3.1.0 | 4.0.2 | Major upgrade, verify API |
| open / clipboardy / strip-ansi | 10.1.2 / 4.0.0 / 7.1.2 | 11.0.4 / 5.3.2 / 7.2.0 | Upgrade |
| Tree-sitter | web-tree-sitter 0.25.10, bash 0.25.0, powershell 0.25.10 | 0.27.1 / 0.25.1 / 0.26.4 | Only patch grammars; OpenTUI 0.6 peers on web-tree-sitter 0.25.10 |
| parcel/watcher | 2.5.1 + 8 explicit platform packages | 2.6.0 | Upgrade; keep platform packages for release cross-builds |
| AWS / Google auth | 3.993.0 / 10.5.0 | 3.1156.0 / 11.3.1 | Upgrade |
| Playwright | 1.59.1 | 1.64.1 | Upgrade (lazy-loaded browser driver) |
| Unused catalog entries | `@solidjs/start` (`pkg.pr.new` canary), `@solidjs/router`, `@solidjs/meta`, `@kobalte/core`, `@solid-primitives/storage`, `tailwindcss`, `@tailwindcss/vite`, `virtua`, `solid-list`, `shiki`, `marked-shiki`, `marked`, `@playwright/test`, `@hono/node-server` (override) | — | Remove |

### Patches and pre-releases removed

- `patches/solid-js@1.9.10.patch` — Solid transition fix #2046, present in
  1.9.17 upstream.
- `patches/@standard-community%2Fstandard-openapi@0.2.9.patch` — external
  `$ref` crash; 0.2.11 handles `http://`/`https://`/`//` refs upstream.
- `@solidjs/start` — `https://pkg.pr.new/...` canary, never imported.
- `@clack/prompts` alpha → stable.
- `drizzle-orm` commit-hash build → tagged release.

## CI and scripts inventory

| Entry point | Before | Change |
|---|---|---|
| `.github/workflows/ci.yml` | 4 jobs, each installs; test and build both compile | Merge into one `validate` job; single install/build; add `bun audit` |
| `.github/workflows/release.yml` | Validate builds without a pinned version (registry fetch, not reproducible) | Pass release version; skip duplicate test discovery |
| `.github/actions/setup-bun` | Pins Bun via `packageManager`; caches Bun cache | Keep; remove patch workaround after patches are gone |
| `packages/axiomsec/script/build.ts` | Installs all OS/CPU optional binaries even for `--single` | Only do that for cross-target release builds |
| `packages/script/src/index.ts` | Build-time registry fetch for version when `latest` | Use local package version; honor `SOURCE_DATE_EPOCH` for preview versions |
| `packages/axiomsec/Dockerfile` | Floating `alpine`, no `--no-cache` | Pin Alpine, `apk add --no-cache`, document runtime |

## Plan mapped to success criteria

1. **Faster** — TS 7 native typecheck, no Turbo, smaller dependency graph,
   lazy command loading so `--version`/`--help` do not initialize the agent,
   OpenTUI 0.6 renderer, verified by the benchmark harness.
2. **Smaller** — remove unused/canary/patched dependencies, OpenTUI's 3D
   stack, Turbo and the native-preview binaries; single-target builds stop
   installing foreign platform binaries; smaller lockfile and image.
3. **Leaner** — lazy-load heavy command/provider modules, avoid duplicate CI
   installs and builds, measure RSS/idle CPU/CI minutes.
4. **Production-ready** — stable Effect/AI SDK/Zod/Solid/TS, no patches or
   `pkg.pr.new`, pinned exact versions, frozen installs, audit gate,
   deterministic release builds, documented breaking changes.
5. **More powerful** — AI SDK 7 (approval/telemetry changes), OpenTUI 0.6
   async lifecycle, Effect 4 stable, TS 7 native compiler, Zod 4 native
   JSON-schema generation replacing `zod-to-json-schema`.

## Validation order

`bun install` → `bun typecheck` → `bun run lint` → `bun test --timeout 60000`
→ `bun run --cwd packages/axiomsec build --single --skip-install` →
`bun script/bench.ts` before/after comparison. Any regression stays open until
explained or fixed.
