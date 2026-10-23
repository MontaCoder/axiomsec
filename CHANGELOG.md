# Changelog

All notable changes to AxiomSec are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] — 2026-10-23

### Fixed

- Linux single-target builds no longer require OpenTUI 0.6's unused musl and
  foreign-OS native packages. The build now externalizes every non-target
  `@opentui/core-*` variant while bundling the target's native library.
- Release builds install all native variants again so glibc, musl, macOS and
  Windows targets are all built from the same tree.

## [0.5.0] — 2026-10-23

### Performance

- `--version` cold start fell from 389 ms to 29 ms by answering it before
  loading the CLI graph; the full entry now loads as a dynamic chunk.
- Server listen 550 → 447 ms, server RSS 162 → 136 MB, loopback throughput
  2,337 → 2,470 req/s, and TUI first paint 17.5 → 9.2 ms.
- TUI input latency under the deterministic PTY probe rose from 18 to 69 ms
  because OpenTUI 0.6 adds a hardcoded 20 ms stdin disambiguation timer. This
  is the one metric that regressed; it is recorded as `RISK-TUI-01`.
- Install tree 1,641 → 570 MB, lockfile 2,016 → 1,803 lines, and the CI job
  graph was collapsed from four installs plus a duplicate build to one
  validated job.

### Changed

- Bun 1.4.4, TypeScript 7.0.2 (native), oxlint 1.89, Prettier 3.9.10; Turbo
  and the native-preview toolchain removed.
- AI SDK 7.0.151 with deduplicated provider, provider-utils and gateway copies.
- Effect 4.0.6 stable, OpenTUI 0.6.8, Solid 1.9.17, AI SDK 7 with provider
  majors 3/4/5, ACP SDK 2.0.1, Zod 4.6.7, OTel 1.10/0.300/2.12, Hono OpenAPI
  1.5.0, Clack 1.8.1, Drizzle 1.0.0-beta.22.
- Native APIs replace dependencies: `Bun.which`, `Bun.stripANSI`,
  `z.toJSONSchema`.
- Builds are byte-reproducible with `AXIOMSEC_VERSION`, `AXIOMSEC_CHANNEL` and
  `SOURCE_DATE_EPOCH`; a `latest` build no longer fetches the npm registry.
- CI runs `bun audit` before the gates and fails on any advisory.

### Breaking

- ACP 2 removes the legacy connection classes. `session/set_model` is gone from
  ACP v1; use `session/set_config_option` with `configId: "model"`. Fork and
  resume remain supported via the v1 `/unstable` entrypoint.
- AI SDK 7 uses the v4 provider specification. The bundled Copilot provider
  remains v3 (accepted by AI SDK 7); system messages are passed explicitly via
  `allowSystemInMessages`.
- The internal `AppFileSystem.glob` was renamed `globFiles` to avoid colliding
  with Effect 4's `FileSystem.glob`.
- `opentui-spinner` was replaced by a local `SpinnerGlyph`; the TUI spinner
  phases and animation settings are unchanged.

### Removed

- Both Bun patches, the `pkg.pr.new` SolidStart canary, unused catalog
  entries (router/meta, Kobalte, Tailwind, virtual list, Shiki, Marked, Vite,
  Playwright test runner, luxon, dompurify, remend, worker types),
  `opentui-spinner`, `which`, `strip-ansi`, `zod-to-json-schema` and `gray-matter`.
- Turbo, `@typescript/native-preview`, and `@effect/language-service`.

### Security

- `bun audit` is clean (617 packages); the intermediate upgrade tree had 58
  findings, including two critical tar advisories, which `bun audit fix` and
  provider alignment resolved.
- OpenRouter is aligned to v3 across the app and the optional gateway provider,
  removing a nested AI SDK 6 / provider-utils 4 graph.

## [0.4.5] — 2026-10-22

### Security

- MCP tools now use the `mcp` permission instead of a generated `mcp:<key>`
  key that could not match the default rule. They default to ask, and their
  denials and failures reach the cyber ledger (`RISK-MCP-01`, `RISK-AUDIT-06`).
- Per-prompt tool toggles merge with the session ruleset, subagents inherit
  parent deny rules, and forks retain `parentID` and the permission policy
  (`RISK-PERM-11`, `RISK-SESSION-02`, `RISK-SESSION-03`).
- Boundary checks now cover case-insensitive host patterns, every redirect hop,
  scanner subresources and every planned `appsec_probe` route. WebRTC STUN and
  WebTransport are disabled in the guarded browser context, and service-worker
  fetches are covered (`RISK-SCOPE-04/05/06/09/10/11`).
- Finding promotion rejects blank evidence refs and requires independent
  evidence; replay artifacts remain separate from proof (`RISK-PROOF-06`).
- Provider credentials stored in `auth.json` are scrubbed from bash, MCP, PTY
  and generic child-process environments (`RISK-SECRET-07`).
- The evidence locker validates manifest extensions on read, rejects hostile
  extensions and is race-safe under concurrent writes. Vault saves use a
  temp-file rename (`RISK-PERSIST-10/11`).
- The tool wrapper records `tool.called` before schema validation, records
  `tool.error` for malformed calls, redacts persisted input, and no longer
  claims `audit_logged` when the completion row could not be written.
- Adapter-backed triage and autonomy now default to ask instead of falling
  through the catch-all allow rule (`RISK-PERM-09/10`).

### Fixed

- `axiomsec run` keeps streaming the agent answer after a tool call and exits
  non-zero when a session error occurs (`RISK-SESSION-01`).
- Permanent free-tier quota errors fail fast instead of retrying forever.
- Port scanning reports bannerless open ports, and service mode sends its
  active probe instead of silently filtering HTTP listeners (`RISK-SCAN-01`).
- Config setup no longer installs plugins into every config directory or stalls
  commands for roughly a minute (`RISK-CONFIG-01`).
- CLI JSON output goes to stdout, empty session lists emit `[]`, and
  `debug agent` respects `toolset_exclude` (`RISK-CLI-01/02`, `RISK-TOOL-04`).
- Evidence files keep their real extension, text previews work, stale locks
  from dead processes recover immediately, and replay redaction handles inline
  auth/cookie assignments and tool errors (`RISK-TOOL-05`, `RISK-PERSIST-10`,
  `RISK-SECRET-06`).

### Added

- A layered 343-test suite in `packages/axiomsec/test/`: policy, predicate,
  integration, process and end-to-end layers, plus local MCP/plugin fixtures,
  browser HTTP/WebSocket/WebRTC/service-worker tests and opt-in live-provider
  acceptance for Groq/Qwen3.8 27B and OpenRouter/Flint.
- A shared test harness that gives every case its own workspace, XDG state and
  database, with a scripted OpenAI-compatible mock provider and request capture.
- Documentation for the test layers, live-provider gates, browser boundary and
  the updated risk register.

## [0.4.0] — 2026-10-22

### Security

- Bumped the dependencies that carried known advisories on the default branch:
  `@modelcontextprotocol/sdk` 1.27.1 to 1.32.1 (OAuth credential leakage,
  cross-origin redirect header re-send, session-scoped tasks, request body
  memory exhaustion, cross-service bearer tokens), `@ai-sdk/provider-utils`
  4.0.23 to 4.0.33 with `@ai-sdk/provider` 3.0.8 to 3.0.12 (uncontrolled
  resource consumption), `minimatch` 10.0.3 to 10.2.5 (ReDoS), `hono` 4.10.7
  to 4.13.13 (arbitrary file access, JWT algorithm confusion, CORS origin
  reflection, SSE header injection), `diff` 8.0.2 to 8.0.4 and `turbo` 2.8.13
  to 2.9.18. Overrides pin a single copy of each package so the whole tree
  resolves to the fixed version.
- The MCP client now follows an HTTP redirect only within the endpoint's
  origin, so configured headers and OAuth credentials are never re-sent to
  another host. A remote MCP server that redirects cross-origin can opt back
  in with `mcp.<name>.redirect_policy: "follow"`.
- A finding can no longer certify itself. The replay artifact is tracked
  separately and never counts as evidence, so promotion needs at least one
  independently supplied ref that resolves and re-hashes
  (`RISK-PROOF-03`).
- A model-supplied operation slug can no longer redirect a write outside
  `.axiomsec/operation/`. Slugs are validated and every path primitive asserts
  containment (`RISK-SCOPE-07`).
- `opsec`, `scope`, `finding` and `observation` writes now ask before they
  change the operation record, `question`/`plan_exit` consult the permission
  engine, a `deny` rule removes the tool from the model's surface, and a
  stored "always" approval no longer outranks an explicit `deny`
  (`RISK-PERM-07`).
- Plugin and config-file tools now run through the same audit wrapper as the
  built-ins, and MCP tools ask by default and are ledgered
  (`RISK-AUDIT-01`, `RISK-AUDIT-02`).
- Scope and opsec are written to the canonical SQLite kernel first and read
  from it first, so losing the projection no longer silently reverts the
  boundary to `normal` (`RISK-PERSIST-04`).
- Redaction now covers a sensitive key whose value is an object or array, and
  the unquoted `Authorization=` / `Cookie=` assignment forms
  (`RISK-SECRET-04`). Tool arguments are redacted before they are persisted
  in the session database (`RISK-SECRET-05`).

### Fixed

- A single malformed line no longer bricks the evidence locker, and evidence
  artifacts are written atomically so a crash cannot truncate one under a
  digest that claims it is complete (`RISK-PERSIST-05`).
- The deliverable no longer contradicts itself: a finding promoted with a
  structured replay exemption is reportable in both the report body and the
  manifest (`RISK-PROOF-04`), and candidates are no longer counted and
  rendered as suspected findings (`RISK-PROOF-05`).
- Fact and relation writes are single atomic upserts, so concurrent writers
  can no longer lose a row (`RISK-PERSIST-08`). Operation-level projection
  appends take the same file lock as the kernel (`RISK-PERSIST-09`).
- The one-time database migration now runs once. With `AXIOMSEC_DB` set it
  previously re-ran and re-announced itself on every command
  (`RISK-PERSIST-06`).
- `share` no longer leaves a full staging copy of the operation behind
  (`RISK-PERSIST-07`).
- Permission pattern matching no longer depends on the platform
  (`RISK-PERM-08`).
- The projection readers take the tail of the file instead of re-parsing an
  unbounded log on every tool call (`RISK-PERF-01`).
- Boundary URL patterns are now parsed before matching, so a scheme-qualified
  scope such as `https://example.com` no longer allows
  `https://example.com.evil.test` via a raw prefix match (`RISK-SCOPE-04`).
- `http_request`, `webfetch`, scanner crawl/JS, and browser WebSockets now
  re-check the boundary on redirects and discovered subresources, with the
  operator asked before a cross-boundary hop
  (`RISK-SCOPE-05`, `RISK-SCOPE-06`).
- The tool wrapper now passes the Zod-parsed arguments to tool execution, so
  schema defaults and coercions apply; `finding` without `action` returns the
  documented list instead of falling through to promotion (`RISK-TOOL-02`).
- `evidence add_file`, `binary_triage`, and `iac_triage` now apply the
  external-directory and `read` permission gates to user-supplied paths
  (`RISK-PERM-05`), and `interact` asks before spawning or managing sessions
  (`RISK-PERM-06`).
- Triage adapters run with a bounded subprocess timeout (`RISK-TIME-02`).

### Added

- A tracked test suite in `packages/axiomsec/test/`, wired into `bun test`,
  `bunfig.toml`, `.gitignore` and CI. It covers the security predicates:
  boundary matching, finding reportability, redaction, permission precedence,
  the evidence locker, and operation-slug containment. End-to-end paths are
  still covered by the manual `V-S*` scenarios in `docs/agents/VERIFICATION.md`.
- `V-S13` in `docs/agents/VERIFICATION.md`: proof independence, slug
  containment, the security-state permission gate, canonical scope state, and
  the one-time migration check.

## [0.3.1] — 2026-10-22

### Fixed

- Clean-install Linux builds now resolve `@hono/standard-validator`, which
  `hono-openapi` imports unconditionally. The dependency is declared directly
  and pinned to `0.2.3`, so release validation no longer fails while bundling
  the binary.

## [0.3.0] — 2026-10-21

### Fixed

- Finding promotion now resolves every evidence ref against the operation’s
  evidence manifest and re-hashes the stored bytes; fabricated or tampered
  refs are rejected with `unresolved_evidence` instead of being promoted as
  verified (`RISK-PROOF-01`).
- `debug agent --tool` now runs the tool’s Effect and returns the actual
  result instead of printing an unevaluated effect object (`RISK-TOOL-01`).
- Share bundles now redact structured JSON/JSONL/HAR and broader text formats,
  including Authorization/Cookie headers and common secret keys, instead of
  JWTs only (`RISK-SECRET-01`).
- `share build` now works on Windows: tar runs with a relative archive path and
  the operation directory as its cwd instead of passing `C:\...` arguments
  (`RISK-BUILD-04`).
- `browser` and `net` now enforce the active operation boundary before egress;
  `browser` also aborts HTTP(S) requests that are not explicitly in scope.
  `bash` remains unguarded (`RISK-SCOPE-03`).
- Operation creation now reserves slugs atomically and retries with random
  suffixes, so repeated or concurrent same-label creates cannot clobber state
  (`RISK-PERSIST-02`).
- Path containment now canonicalizes symlinks and junctions before comparing,
  closing an external-directory prompt bypass (`RISK-PATH-01`).
- Dev database and replay signing temp files now use `os.tmpdir()` with unique
  names and cleanup; replay signing spawns have a 10-second timeout
  (`RISK-BUILD-01`, partial `RISK-TIME-01`).
- Tool ledger and workflow projections now redact secret-bearing arguments, and
  vault/identity secret operations request permission before acting
  (`RISK-SECRET-02` partial).
- `debug agent --tool` now refuses ask-level permissions unless
  `--dangerously-skip-permissions` is passed, and prints every bypass
  (`RISK-PERM-02`).
- Network, shell, and secret tools (`bash`, `net`, `scanner`, `http_request`,
  `browser`, `webfetch`, `websearch`, `appsec_probe`, `vault`, `identity`,
  `share`) now default to `ask`; the read-only explore agent keeps its explicit
  allows (`RISK-PERM-01` partial).
- `serve` now refuses non-loopback binds without `AXIOMSEC_SERVER_PASSWORD`,
  and MCP OAuth callbacks bind explicitly to `127.0.0.1` (`RISK-NET-02`).
- Operation migration now marks success only after migration completes, logs
  failures and retries, and aggregates per-operation errors instead of
  swallowing them (`RISK-PERSIST-03`).
- `replay verify` now verifies minisign/cosign signatures when a public key is
  configured and fails closed with `UNVERIFIED` otherwise; `replay show` labels
  the signature state (`RISK-PROOF-02`).
- `run --dangerously-skip-permissions` now prints a prominent stderr warning
  before the session loop (`RISK-PERM-03`, accepted risk).
- Docs/config cleanup: README documents `/init` and the registry as the tool
  source of truth; `.oxlintrc.json` has no duplicate `options` keys and
  `.editorconfig` matches the 120-column Prettier width (`RISK-DOC-01`,
  `RISK-DOC-02`, `RISK-LINT-01`).
- A boundary `ask` now issues a separate `scope` permission (default `ask`) on
  all Guarded egress tools, so a tool-level allow can no longer silently
  approve out-of-scope traffic (`RISK-SCOPE-02`).
- Browser sessions are scoped by workspace + operation + TLS mode and close on
  switch; invalid TLS certificates are rejected unless `ignore_https_errors` is
  explicitly enabled (`RISK-NET-01`).
- Share signing/tar, registry version checks, and installer subprocesses now
  have explicit timeouts; SDK streaming remains intentionally unbounded and
  requires caller cancellation (`RISK-TIME-01`).
- The server no longer accepts `auth_token` query parameters; only the standard
  Authorization header authenticates (`RISK-NET-03`).
- Evidence manifest reads/appends and cyber projection appends now take a
  shared cross-process file lock; concurrent same-content puts yield one
  manifest entry (`RISK-PERSIST-01`).
- Snapshot ignore checks now batch git pathspecs, fixing
  `ENAMETOOLONG: uv_spawn` after model steps on large workspaces
  (`RISK-SNAPSHOT-01`).

## [0.2.0] — 2026-10-21

Agent harness documentation release plus a build-tooling fix. No runtime
behavior changes.

### Added

- **Layered agent harness.** Root `AGENTS.md` (auto-loaded into AxiomSec
  sessions) plus on-demand `docs/agents/` playbooks for architecture,
  invariants, debugging, bug hunting, change recipes, verification, and a
  dated risk register.
- **PR verification template.** Risk classification, automated and manual
  proof, invariant checks, and rollback notes.
- **Dated risk register.** Documents verified scope/permission/proof/secret
  gaps, persistence and concurrency risks, platform/build issues, and the
  `/initialize` vs `/init` documentation drift, with safe re-verify commands.

### Changed

- Version bumped to `0.2.0` across `axiomsec`, `@axiomsec/sdk`,
  `@axiomsec/plugin`, and `@axiomsec/shared`.
- README version banner updated to 0.2.0.

### Fixed

- Standalone builds no longer fail when the bundler tries to resolve
  Playwright’s optional `electron` and `chromium-bidi` imports; those paths are
  externalized in `packages/axiomsec/script/build.ts`.
- Release validation now runs `bun test` only when test files exist, so the
  lite repo no longer fails its release gate on zero tests.
- The npm publish job no longer references a missing `postinstall.mjs`; the
  launcher resolves the platform binary from its optional dependency.
- `@axiomsec/shared` now declares `glob`, so clean Linux installs can
  typecheck without relying on a hoisted transitive dependency.
- `axiomsec` now declares `gitlab-ai-provider`, so clean installs and builds
  resolve the GitLab provider instead of relying on a hoisted package.
- Release-note extraction now strips the optional date after a changelog
  version header.

### Notes

- Documentation and build-tooling release; runtime behavior is unchanged.
- The lite repository still ships no tests. Verification remains
  typecheck/lint/build plus the manual scenarios in
  `docs/agents/VERIFICATION.md`.
- Use AxiomSec only on systems you own, lab environments, CTFs, or targets you
  are explicitly authorized to test.

## [0.1.0] — 2026-10-21

Initial release of AxiomSec: a terminal-native AI cyber operator harness for
authorized AppSec and pentest work.

This is the first release on the 0.x version line. While AxiomSec is pre-1.0,
minor releases may still include breaking changes to the config schema, SDK
surface, and CLI.

### Added

- **Terminal app + TUI.** Runs on Bun (≥ 1.3.11) with an animated
  cyber-decryption logo (rain → scan → ignite reveal, data-burst sweeps and
  glyph glitches), phase-aware spinners, a breathing status label, and a live
  scanner pass in the prompt.
- **Five built-in cyber agents** — `security`, `pentest`, `appsec`, `osint`,
  `hacking` — each with a hand-curated system prompt, tool-routing examples, a
  permission ruleset, and a narrowed tool surface via `toolset_exclude` (for
  example, the `osint` agent never sees active scanners). Hidden specialised
  agents (`compaction`, `title`, `summary`) handle internal housekeeping.
- **Cyber kernel.** Operations, scoped engagements, the findings lifecycle
  (candidate → observed → verified → reportable), evidence capture, replay,
  and a provenance-aware knowledge broker keep target, scope, proof, and
  deliverables together across sessions.
- **47 built-in tools**, including terminal & files (`bash`, `read`, `write`,
  `edit`, `apply_patch`, `grep`, `glob`), web & application testing
  (`http_request`, `browser`, `scanner`, `appsec_probe`), operation control
  (`runbook`, `pwn_bootstrap`, `scope`, `opsec`, `autonomy`, `identity`),
  proof workflow (`evidence`, `observation`, `finding`, `report`, `share`,
  `remediate`), security intelligence (`knowledge`, `methodology`, `cve`),
  and environment (`doctor`, `workspace`, `vault`, `net`, `crypto`,
  `analyze`).
- **6 ship-in-box themes** — `axiomsec`, `axiomsec-blackhat`,
  `axiomsec-blueteam`, `axiomsec-redteam` (default), `dracula`, `matrix`.
- **10 slash commands** — `/doctor`, `/initialize`, `/opsec`, `/play`,
  `/pwn`, `/remediate`, `/review`, `/runbook`, `/share`, `/teach`.
- **Full CLI surface** — `run`, `attach`, `serve`, `providers` (alias
  `auth`), `models`, `agent`, `session`, `operation` (alias `op`), `plugin`
  (alias `plug`), `mcp` (alias `ls`), `acp`, `replay`, `export`, `stats`,
  `pr`, `db`, `debug`, `upgrade`, `uninstall`, `completion`.
- **Headless server and integrations.** Hono-based HTTP server with an
  OpenAPI description, an ACP (Agent Client Protocol) server, MCP (Model
  Context Protocol) server management, and a typed client (`@axiomsec/sdk`).
- **Plugin API.** `@axiomsec/plugin` exposes hooks to observe runtime events
  and intercept tool execution, plus custom tool and TUI extension points;
  `@axiomsec/shared` carries utilities reused across packages.
- **Skills.** A skill loader with bundled skills (for example `passive-osint`
  and `forensics-kit`) that inject domain-specific instructions and workflows
  on demand.
- **Broad provider coverage.** OpenAI, Anthropic, Google / Vertex, xAI, Amazon
  Bedrock, Groq, Azure, OpenRouter, Vercel AI Gateway, OpenAI-compatible
  endpoints and other provider families, managed with `axiomsec providers`
  and `axiomsec models`.

### Notes

- Persistence is SQLite via Drizzle; no external database is required.
- Licensed AGPL-3.0-or-later. Use AxiomSec only on systems you own, lab
  environments, CTFs, or targets you are explicitly authorized to test.

---

[Unreleased]: https://github.com/MontaCoder/axiomsec/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.5.1
[0.5.0]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.5.0
[0.4.5]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.4.5
[0.4.0]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.4.0
[0.3.1]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.3.1
[0.3.0]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.3.0
[0.2.0]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.2.0
[0.1.0]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.1.0
