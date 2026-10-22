# Changelog

All notable changes to AxiomSec are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/MontaCoder/axiomsec/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.3.1
[0.3.0]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.3.0
[0.2.0]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.2.0
[0.1.0]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.1.0
