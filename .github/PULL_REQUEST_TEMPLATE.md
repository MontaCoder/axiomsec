<!-- Delete sections that do not apply. Keep this short. -->

## What changed and why

<!-- 2-4 lines. Link the invariant/risk ID if applicable. -->

## Risk classification

- [ ] Scope / Guard
- [ ] Permissions / approval
- [ ] Findings / evidence / replay
- [ ] Secrets / server / MCP
- [ ] Persistence / concurrency
- [ ] Generated files / API / SDK
- [ ] Docs only

## Proof

Automated:

- [ ] `bun typecheck`
- [ ] `bun run lint`
- [ ] `bun run --cwd packages/axiomsec build --single --skip-install`
- [ ] Not run (why):

Manual scenario from `docs/agents/VERIFICATION.md`:

- Scenario ID:
- Command / setup:
- Result:
- Evidence (output, DB row, artifact path):

- [ ] I did not claim tests. This lite repo ships none; `bun test` is a no-op.

## Invariants and docs

- [ ] Checked `docs/agents/INVARIANTS.md` for Guard, `ctx.ask`, timeout, Instance state, and generated-file rules.
- [ ] New/updated risk ID in `docs/agents/KNOWN-RISKS.md`:
- [ ] Docs updated in this PR, or no behavior/command/path changed.
- [ ] Links resolve; `AGENTS.md` remains ≤150 lines.

## Rollback

<!-- How to revert safely; any data/migration caveat. -->
