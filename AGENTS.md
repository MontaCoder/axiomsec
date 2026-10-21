# AxiomSec Agent Guide

AxiomSec is a pre-1.0 terminal-native AI agent harness for **authorized** AppSec/pentest operations: an operation-centric security workspace, not a scanner wrapper or chatbot. This file is injected into every AxiomSec session by `packages/axiomsec/src/session/instruction.ts:20-26`; every line costs context. Code and SQLite are canonical; this file is a map.

Request path in one breath: TUI or `serve` → session loop → model → tool registry → `Tool.wrap` → tool (Guard/ask) → cyber kernel and evidence.

## Route by task

| Situation | Read first | Then | Do not |
|---|---|---|---|
| Changing code | [ARCHITECTURE.md](docs/agents/ARCHITECTURE.md) | [CHANGE-PLAYBOOKS.md](docs/agents/CHANGE-PLAYBOOKS.md) | Start from README or guess the layer |
| Touching scope, permissions, findings, secrets | [INVARIANTS.md](docs/agents/INVARIANTS.md) | [KNOWN-RISKS.md](docs/agents/KNOWN-RISKS.md) | Weaken a rule to match current behavior |
| Diagnosing a failure | [DEBUGGING.md](docs/agents/DEBUGGING.md) | [VERIFICATION.md](docs/agents/VERIFICATION.md) | Guess from one log line |
| Hunting proactively | [BUG-HUNTING.md](docs/agents/BUG-HUNTING.md) | [KNOWN-RISKS.md](docs/agents/KNOWN-RISKS.md) | Scan third-party targets |
| Proving a change | [VERIFICATION.md](docs/agents/VERIFICATION.md) | [PR template](.github/PULL_REQUEST_TEMPLATE.md) | Claim tests passed |

## Non-negotiables

1. **Authorized targets only.** Use owned systems, labs, or loopback fixtures for verification; never send test traffic to third-party hosts.
2. **Operation before target work.** Create/attach an operation first. `Guard.check` returns `allow` when no operation is active (`packages/axiomsec/src/core/boundary/guard.ts:87-118`).
3. **Guard every target-touching tool.** Call `Guard.check*` before DNS, sockets, browser launch, or subprocess. Current gaps: `browser`, `net`, `bash`.
4. **Ask before side effects.** Sensitive tools need `ctx.ask`. Built-in defaults are `"*": "allow"` (`packages/axiomsec/src/agent/agent.ts:110-127`), so an ask only prompts when the resolved ruleset says `ask`.
5. **Findings need proof.** Reportable means `kind=finding`, `status=verified`, non-empty evidence refs, and replay present OR a structured domain-valid exemption (`packages/axiomsec/src/core/cyber/finding.ts:189-194`). Never weaken the oracle.
6. **Evidence is immutable; secrets are narrow.** Evidence is SHA-256 addressed; do not mutate bytes or hand-edit `manifest.jsonl`. Tool args are ledgered and share redaction is limited — never put real credentials in args, logs, evidence, or shares.
7. **SQLite cyber kernel is canonical.** JSONL, context packs, reports, and markdown notebooks are projections (`packages/axiomsec/src/core/operation/operation.ts:1-14`).
8. **Per-project state lives in `Instance`/`InstanceState`.** No module-global `Map`/`Set` for project or session data.
9. **Network and subprocess calls need a timeout or abort.** Do not add a bare `fetch`/`spawn`/`exec`.
10. **Never hand-edit generated files:** `packages/sdk/src/v2/gen/*`, `packages/axiomsec/src/providers/models-snapshot.*`, applied migrations.

## Commands that matter

```bash
bun install
bun typecheck
bun run lint
bun run --cwd packages/axiomsec build --single --skip-install
bun run --cwd packages/axiomsec dev
```

Use Bun 1.3.11 (the `packageManager` pin); CI installs that version, and a newer local Bun can change bundling behavior. Run `bun install --frozen-lockfile` for CI parity. The build also smoke-tests the produced binary with `--version`.

## Tests: the uncomfortable truth

`bun test` at the repo root prints “tests are not shipped in this lite repo” and exits 0 (`package.json:12`). Test directories/files are gitignored, and `bunfig.toml:4-5` points Bun’s test root at a nonexistent directory. The release workflow runs `bun test --timeout 30000` only when test files exist; this lite repo has none, so the step is skipped. **Do not write “tests pass.”**

## Definition of done

- [ ] `bun typecheck` passes.
- [ ] `bun run lint` passes; warnings were read, not ignored.
- [ ] `bun run --cwd packages/axiomsec build --single --skip-install` passes, or the PR states exactly why it could not run.
- [ ] The relevant `V-S*` scenario in [VERIFICATION.md](docs/agents/VERIFICATION.md) was run, with command output or artifact paths in the PR.
- [ ] The change was checked against [INVARIANTS.md](docs/agents/INVARIANTS.md); any new/changed risk is in [KNOWN-RISKS.md](docs/agents/KNOWN-RISKS.md) with a date and `file:line`.
- [ ] If behavior, commands, generated files, or paths changed, the matching deep doc was updated in the same PR.

## Danger zone

- **Do not run `/init` at repo root.** It is the guided `AGENTS.md` writer (`packages/axiomsec/src/commands/template/initialize.txt:1`), not an operation initializer, and it can rewrite this file. Create operations with `/pwn <target>` or `axiomsec operation new`.
- `axiomsec debug agent` runs a tool without an LLM call but turns `ask` into allow except explicit deny (`packages/axiomsec/src/cli/cmd/debug/agent.ts:181-190`). Use a disposable workspace only.
- `axiomsec run --dangerously-skip-permissions` auto-approves every ask (`packages/axiomsec/src/cli/cmd/run.ts:544-548`). Do not use it on real targets.
- Never commit `.env`, `.axiomsec/`, logs, vault exports, real evidence, or customer data.
- Never expose `serve` beyond loopback without `AXIOMSEC_SERVER_PASSWORD` and an explicit operator decision.

## Working rules

- Read `packages/axiomsec/src/tools/tool.ts:205-450` before changing tool behavior; the wrapper owns ledger, workflow, context refresh, and truncation.
- Make the smallest change that restores the invariant. No drive-by refactors or unrelated reformatting; Prettier is configured but unenforced.
- Do not add test files in an ordinary PR. Tests are not tracked here; propose a test harness as a separate repo-structure change (`.gitignore`, `bunfig.toml`, CI).
- Update the deep doc and risk register in the same PR as the behavior change.
- If this file and code disagree, code wins: fix this file or file a risk. Keep this file ≤150 lines (`wc -l AGENTS.md`); move detail into the deep docs.

## Deep docs

- [ARCHITECTURE.md](docs/agents/ARCHITECTURE.md) — runtime topology, session/tool loop, cyber kernel, surfaces, paths.
- [INVARIANTS.md](docs/agents/INVARIANTS.md) — `SEC-*`/`ENG-*` rules with enforcement and checks.
- [DEBUGGING.md](docs/agents/DEBUGGING.md) — instruments, clean-room setup, symptom-to-layer triage.
- [BUG-HUNTING.md](docs/agents/BUG-HUNTING.md) — audit loop, command bank, reproduction patterns.
- [CHANGE-PLAYBOOKS.md](docs/agents/CHANGE-PLAYBOOKS.md) — recipes for tools, agents, commands, plays, migrations, routes, fixes.
- [VERIFICATION.md](docs/agents/VERIFICATION.md) — no-test gate, manual scenarios, evidence format.
- [KNOWN-RISKS.md](docs/agents/KNOWN-RISKS.md) — dated risk register with re-verify commands.
