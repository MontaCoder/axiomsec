# AxiomSec Testing Strategy

Read when: adding a test, deciding what to test, or judging whether a change is
safe to ship.

This document describes **how the agent is tested**. The manual scenarios that
prove behaviour a unit cannot reach live in [VERIFICATION.md](VERIFICATION.md);
the rules the tests must not break live in [INVARIANTS.md](INVARIANTS.md).

## 1. What "the agent works" has to mean

AxiomSec is not a library. The thing that matters is a chain:

```
model endpoint -> session loop -> tool registry -> Tool.wrap -> tool
              -> Guard / ctx.ask -> cyber kernel -> evidence -> report
```

Every link in that chain can break silently, and most of them did at some
point in this repository's history. The test strategy is organised around the
chain, not around the code layout: each layer proves one link, and the layers
run in increasing order of cost.

| Layer | Directory | Proves | Cost | Needs a build |
|---|---|---|---|---|
| L0 policy | `test/policy/` | The *shape* of the code still satisfies the invariants | ~0.1 s | no |
| L1 predicate | `test/core/**`, `test/permissions/` | A pure decision function returns the right answer (boundary, findings, replay, knowledge, play, plans, retries, locks) | ~1 s | no |
| L2 integration | `test/core/evidence/`, `test/core/support/` | A service works against the real filesystem, content addressing and the shared lock | ~1 s | no |
| L3 process | `test/security/` | The shipped CLI enforces a rule end to end, and the kernel records it | ~1.5–8 s per case | yes |
| L4 end to end | `test/e2e/` | The agent loop drives a model, calls tools and answers | ~1.5–3 s per case | yes |
| L4-live | `test/e2e/openrouter-flint.test.ts`, `test/e2e/groq-qwen.test.ts` | A real provider and real model answer and call guarded tools | network | yes |
| L5 manual | `VERIFICATION.md` `V-S*` | The parts a test cannot own: TUI, browser, WebRTC, installers | minutes | yes |

**The rule that keeps this honest:** a defect is only "fixed" when a test in
L0–L4 fails without the fix. A fix with no test is a fix that will come back.

## 2. Running the layers

```bash
bun test                                  # everything
bun test packages/axiomsec/test/policy   # one layer
bun test --timeout 60000                  # the binary-driven layers need a generous timeout
```

L3 and L4 drive the **built binary**, because the dev entry (`bun src/index.ts`)
re-transpiles on every start and is roughly twenty times slower — 18 s versus
375 ms for `--version`. A suite that spawns the CLI dozens of times is not
practical against the dev entry.

```bash
bun run --cwd packages/axiomsec build --single --skip-install
```

Without a build, L3 and L4 **skip** rather than fail, so a fresh checkout can
still run the fast layers. CI builds first (`ci.yml`, the `Test` job), so
there they always run and a broken build fails the gate.

## 3. The harness

`packages/axiomsec/test/support/` holds the shared fixtures.

- `harness.ts` — locates the built binary, creates a disposable workspace, runs
  the CLI against it, and reads the cyber kernel back out of SQLite.
- `provider.ts` — a scripted OpenAI-compatible streaming endpoint, so a test can
  make the model ask for a tool and then answer.

Two rules the harness enforces:

- **Isolation.** Every case gets its own temporary directory, its own XDG
  state, its own vault home and its own SQLite database. Nothing a test writes
  can reach the developer's real state, and no two cases can see each other.
- **The kernel is the assertion surface.** Tests assert against the database
  (`cyber_ledger`, `cyber_fact`) and the workspace files, not against log lines
  or printed output. Output is a projection; the kernel is canonical.

## 4. Writing a test

**Determinism.** No wall-clock assertions, no real network, no real model. The
mock provider is scripted per case; a model that wants to call a tool gets a
tool call, and a model that wants to answer gets text.

**The title generator is not part of your script.** The session title is
generated on a separate model call. The mock recognises it and answers it on
its own, so it never consumes a turn from the script — otherwise every script
would be off by one.

**Assertions go to the kernel.** A tool call is proved by a `tool.called` /
`tool.completed` pair in `cyber_ledger` with the operation slug, not by the
absence of an error on stdout.

**Timeouts are explicit.** A case that spawns the CLI needs a timeout far above
the default five seconds.

**A regression test names the risk it protects.** The suite file and the test
name carry the risk id (`RISK-PROOF-03`), so a reader can trace a failure back
to the register.

## 4b. Live provider tests (opt-in)

The mock proves the agent loop; it cannot prove that a real provider accepts
our request shape, tool schema or streamed response. Two live suites cover
that boundary, one per provider:

```bash
OPENROUTER_API_KEY=... OPENROUTER_LIVE=1 \
  bun test packages/axiomsec/test/e2e/openrouter-flint.test.ts --timeout 240000

GROQ_API_KEY=... GROQ_LIVE=1 \
  bun test packages/axiomsec/test/e2e/groq-qwen.test.ts --timeout 300000
```

Each suite asks for an exact token, then asks the model to call
`http_request` against a loopback fixture and store the response with
`evidence`. Both assert on stdout events and the cyber ledger, not on prose.

Groq's on-demand tier limits `qwen/qwen3.8-27b` to 7,000 input tokens per
minute, below the full default tool surface. The Groq suite therefore runs a
hidden `qwen` agent whose `toolset_exclude` leaves only `http_request` and
`evidence`. It validates the provider, agent loop, guard, tool execution and
kernel persistence, but not the full default prompt/tool inventory.

**Verification status (2026-10-22):** the Groq/Qwen suite passed both cases on
this reduced surface. OpenRouter/Flint remains unverified because the
free-tier daily quota was exhausted; the reported reset was
2026-10-23T00:00:00Z. The run used Bun 1.4.4 while CI pins 1.3.11, so that
parity remains a release check.

Rules for this layer:

- The key is read from the environment and never written to a file or a test.
- The fixture is loopback; `--dangerously-skip-permissions` is used only there.
- The model and prompt are pinned, so a failure means the provider path or the
  loop broke, not that a different model phrased the answer differently.
- A daily free-tier quota (`free-models-per-day`) is permanent for the day and
  must fail fast with exit 1; it must not be retried. See `RISK-TIME-03`.

## 5. Adding a regression for a new defect

1. Reproduce it against the real artifact first, and write down the exact
   command.
2. Decide the layer:
   - the defect is a **decision** → L1, a pure function;
   - the defect is a **shape** of the code (an unguarded egress, a tool that
     bypasses the wrapper) → L0, a policy assertion;
   - the defect is a **service** that writes state → L2, against the real
     filesystem or database;
   - the defect is a **rule the product must enforce** → L3, drive the CLI and
     assert on the kernel;
   - the defect is in the **agent loop** → L4, script the model.
3. Write the test so it **fails** on the unfixed code. Verify this by
   reverting the fix and running the suite — a regression test that has never
   been seen red is not evidence of anything.
4. Record the defect in [KNOWN-RISKS.md](KNOWN-RISKS.md) with the file and
   line, the evidence, and the re-verify command.

## 6. The policy layer

L0 exists because some of this repository's rules are about *code shape*, and
shape regressions are invisible to behavioural tests. A tool that stops calling
`ctx.ask` still passes every unit test; it only fails when a user is
surprised.

The current assertions encode the checks that `INVARIANTS.md` already states as
greps:

| Assertion | Invariant |
|---|---|
| A tool file defines its tool through `Tool.define` | `ENG-04` |
| `Tool.sideEffects` only uses the declared categories | `ENG-04` |
| A tool that reaches the network or a browser consults the Guard | `SEC-01`, `SEC-02` |
| The operation path primitives keep their containment checks | `SEC-01` |

The egress rule carries an **exception list**, and every entry in it names the
risk id that accepts it. That is deliberate: an exception has to be written
down to survive, and a new one has to be justified rather than slipped in.

## 7. What is still manual, and why

| Area | Why it is not automated |
|---|---|
| TUI rendering and interaction | Needs a terminal and a human; the suite has no TTY model |
| Browser and Playwright | Automated when a Chromium executable is found (bundled revision or `AXIOMSEC_CHROMIUM_PATH`): in-scope page, blocked subresource, blocked WebSocket, denied navigation, blocked WebRTC STUN and service-worker egress. Skipped otherwise; DNS-prefetch and TLS-policy coverage remain manual |
| Real provider behaviour | Covered opt-in by `openrouter-flint.test.ts` and `groq-qwen.test.ts`; CI skips them without keys, so a provider API change is still a manual follow-up. The Groq run uses a reduced tool surface because of its ITPM limit |
| Server auth and bind rules | Automated for loopback/Basic/query-token and non-loopback refusal; the full `V-S5` matrix remains manual |
| Installers, signers and update channels | They mutate the machine; they are not safe to run in CI |
| MCP servers, plugins, ACP/TUI transports | MCP ask/deny/allow/error and plugin wrapper/validation/pure-mode are automated with local fixtures; ACP/TUI transports are not |
| Cloud, container, IaC and binary adapters | Missing-adapter behavior and the `ask` defaults are automated; real checkov/trivy/prowler scans need their CLIs and credentials |
| Knowledge broker and CVE lookups | Live third-party APIs; offline normalization, NVD matching and caching are automated |

Those are the `V-S*` scenarios in [VERIFICATION.md](VERIFICATION.md). They are
not a gap in the strategy — they are the part of the strategy that needs a
human, a disposable machine and a pair of eyes.

## 8. Proving the suite still works

A suite that cannot fail is worse than no suite. Two ways to check:

```bash
# 1. Does the suite catch a reverted fix?
git checkout <commit-before-the-fix> -- <the-fixed-file>
bun run --cwd packages/axiomsec build --single --skip-install
bun test                       # the matching regression must go red
git checkout HEAD -- <the-fixed-file>

# 2. Does the fast layer still guard the shape?
bun test packages/axiomsec/test/policy
```

Do (1) at least once per layer that was added, and record the outcome in the
pull request. The layers in this repository were each proven by reverting a
real fix and watching the matching test fail.
