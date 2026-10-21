# Changelog

All notable changes to AxiomSec are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/MontaCoder/axiomsec/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MontaCoder/axiomsec/releases/tag/v0.1.0
