# AxiomSec

> Terminal-native AI agent harness for AppSec and pentest operations.

AxiomSec wraps a model with a security workspace instead of a chat box. It keeps target, scope, runbooks, findings, evidence, replay state and reports together while the work is happening — inside the terminal you already use.

```
 █████╗ ██╗  ██╗██╗ ██████╗ ███╗   ███╗███████╗███████╗ ██████╗
██╔══██╗╚██╗██╔╝██║██╔═══██╗████╗ ████║██╔════╝██╔════╝██╔════╝
███████║ ╚███╔╝ ██║██║   ██║██╔████╔██║███████╗█████╗  ██║
██╔══██║ ██╔██╗ ██║██║   ██║██║╚██╔╝██║╚════██║██╔══╝  ██║
██║  ██║██╔╝ ██╗██║╚██████╔╝██║ ╚═╝ ██║███████║███████╗╚██████╗
╚═╝  ╚═╝╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝╚══════╝ ╚═════╝
```

**Version:** 0.5.0 · **License:** AGPL-3.0-or-later · **Runtime:** Bun ≥ 1.4.4 · **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md)

---

## Table of contents

- [What it is](#what-it-is)
- [Highlights](#highlights)
- [Install](#install)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Slash commands](#slash-commands)
- [Tool surface](#tool-surface)
- [Models and providers](#models-and-providers)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Plugins and SDK](#plugins-and-sdk)
- [Scope and honest limits](#scope-and-honest-limits)
- [License](#license)

---

## What it is

AxiomSec is an **open source AI security agent that runs inside your terminal**. It is built for people who already live between shell, browser, HTTP requests, scanners, advisories, notes and reports — and want a model that lives in the same loop instead of beside it.

It is:

- **Not** a chatbot.
- **Not** a scanner wrapper.
- **Not** a Burp or Kali replacement.

It is a security workspace built around a model. The model can reason and act; AxiomSec keeps the operation around it: tools, runbooks, events, facts, evidence, replay, findings and deliverables.

AxiomSec is shaped around **authorized AppSec and Pentest workflows**. Other surfaces (OSINT, CTF/lab, cloud, container, IaC, binary triage) exist or are planned but are not marketed as equally mature yet.

## Highlights

| Capability | What you get |
| --- | --- |
| Cyber agents | Switch posture between AppSec, Pentest, OSINT, CTF/lab and research-style work without restarting. |
| Runbooks | Repeatable security workflows that keep the agent moving through a real task instead of random tool calls. |
| Operation memory | Target, scope, activity, findings, evidence, replay and report state stay together across sessions. |
| Findings lifecycle | Candidate → observed → verified → reportable, with rejection and stale states kept visible. |
| Evidence + replay | Capture what was observed and the steps that produced it, so important work is reproducible. |
| Local tools first | Uses tools already installed on your machine and reports what is available, missing or degraded. |
| Reports | Generate deliverables from the operation instead of reconstructing everything at the end. |
| Share bundles | Export an operation so it can be reviewed, resumed or handed off. |
| Plugins | Extend the agent through `@axiomsec/plugin`. |
| Headless server | Run the same engine without the TUI for scripting and integrations. |
| ACP / MCP | First-class Agent Client Protocol surface and Model Context Protocol server management. |

## Install

AxiomSec runs on Bun.

```bash
# from source (recommended during 0.1.x)
git clone https://github.com/MontaCoder/axiomsec.git
cd axiomsec
bun install
bun --cwd packages/axiomsec run dev
```

Or build a standalone binary:

```bash
bun install
bun --cwd packages/axiomsec run build
# binary is emitted into packages/axiomsec/dist/<platform>/
```

## Quick start

Open AxiomSec inside an authorized workspace, lab or owned target:

```bash
axiomsec
```

Inside the TUI:

```text
/doctor                 inspect local tool readiness
/init                  create or update the AGENTS.md harness
/runbook                start a security workflow
/pwn <target>           create a scoped pentest operation for a target
/share                  export the active operation
```

Run a one-shot non-interactive prompt:

```bash
axiomsec run "scan the auth flow on http://localhost:3000 for IDOR candidates"
```

Continue the last session:

```bash
axiomsec --continue
```

Use AxiomSec only on systems you own, lab environments, CTFs or targets where you have explicit permission to test.

## CLI reference

All subcommands accept `-h`/`--help`.

| Command | Purpose |
| --- | --- |
| `axiomsec` *(default)* | Start the TUI in the current project. |
| `axiomsec run <message>` | Run a single prompt without entering the TUI. |
| `axiomsec attach <url>` | Attach the TUI to a running headless server. |
| `axiomsec serve` | Start a headless server (no TUI). |
| `axiomsec providers` *(alias: `auth`)* | Manage AI providers and credentials. |
| `axiomsec models [provider]` | List and refresh available models. |
| `axiomsec agent` | Manage agents (create, list). |
| `axiomsec session` | Manage sessions. |
| `axiomsec operation` *(alias: `op`)* | Manage operations (engagements, reviews, investigations). |
| `axiomsec plugin <module>` *(alias: `plug`)* | Install a plugin and update config. |
| `axiomsec mcp` *(alias: `ls`)* | Manage MCP (Model Context Protocol) servers. |
| `axiomsec acp` | Start an ACP (Agent Client Protocol) server. |
| `axiomsec replay <command>` | Save and replay AxiomSec engagements (`.axiomsec` files). |
| `axiomsec export [sessionID]` | Export session data as JSON. |
| `axiomsec stats` | Show token usage and cost statistics. |
| `axiomsec pr <number>` | Fetch and check out a GitHub PR branch, then run AxiomSec on it. |
| `axiomsec db` | Database tools (path, migrate, query). |
| `axiomsec debug` | Debugging and troubleshooting tools. |
| `axiomsec upgrade [target]` | Upgrade AxiomSec to the latest or a specific version. |
| `axiomsec uninstall` | Uninstall AxiomSec and remove all related files. |
| `axiomsec completion` | Generate a shell completion script. |

Common options:

```text
--continue, -c        continue the last session
--session, -s <id>    continue a specific session
--prompt <text>       initial prompt
--agent <name>        agent to use
--model, -m <id>      model to use, format provider/model
--port <n>            port to listen on (serve / attach)
--hostname <h>        hostname to listen on
--cors <origin...>    additional origins to allow
--pure                run without external plugins
--print-logs          print logs to stderr
--log-level <level>   DEBUG | INFO | WARN | ERROR
```

## Slash commands

Inside the TUI, slash commands launch built-in workflows. The following ship with AxiomSec 0.1:

| Command | What it does |
| --- | --- |
| `/doctor` | Inspect local tool readiness (which security tools are available, missing or degraded). |
| `/init` | Create or update the `AGENTS.md` harness. Use `/pwn` or `axiomsec operation new` to scaffold an operation. |
| `/runbook` | Start a runbook-driven security workflow. |
| `/pwn` | Create a scoped pentest operation for a target. |
| `/play` | Run a freeform agent play. |
| `/review` | Review prior work (findings, evidence, replay). |
| `/remediate` | Turn an observation into remediation guidance. |
| `/share` | Export the active operation as a share bundle. |
| `/teach` | Coach the model on a workflow detail. |
| `/opsec` | Adjust opsec posture (boundaries, autonomy, identity). |

Plus all dialogs available via the keyboard (agent switcher, model picker, session list, operation list, MCP, plugins, themes).

## Tool surface

AxiomSec gives the agent a small set of useful security surfaces — not a giant toolbox the model can spam:

- **Terminal & files:** `bash`, `read`, `write`, `edit`, `apply_patch`, `grep`, `glob`
- **Web & application testing:** `http_request`, `browser`, `scanner`, `appsec_probe`
- **Operation control:** `runbook`, `pwn_bootstrap`, `scope`, `opsec`, `autonomy`, `identity`
- **Proof workflow:** `evidence`, `observation`, `finding`, `report`, `share`, `remediate`
- **Security intelligence:** `knowledge`, `methodology`, `cve`
- **Environment:** `doctor`, `workspace`, `vault`, `net`, `crypto`, `analyze`

`knowledge` is the preferred research surface — it routes vulnerability intelligence, package advisories, methodology, tradecraft, exploit signals and installed tool docs through one provenance-aware broker. `cve` remains as a compatibility alias for direct CVE lookup.

Tool ids above are the model-facing names. `packages/axiomsec/src/tools/registry.ts` is the source of truth; registry keys can differ (for example `httprequest` resolves to `http_request`), and `question`, `plan`, `task`, and MCP/plugin tools are conditional.

Local tools make AxiomSec stronger. Recommended baseline:

```bash
# Debian / Kali / Ubuntu
apt install nmap sqlmap ffuf gobuster nikto nuclei trivy checksec

# macOS
brew install nmap sqlmap ffuf gobuster nikto nuclei trivy checksec
```

Run `/doctor` inside the TUI to see what is available, degraded or missing on the current machine.

## Models and providers

AxiomSec is **model-agnostic**. Bring the model you trust; AxiomSec wraps it with a security workflow.

Supported provider families include OpenAI, Anthropic, Google, xAI, Bedrock, OpenRouter, Ollama, Vercel AI Gateway, OpenAI-compatible endpoints and other providers exposed through the local model stack. Use `axiomsec providers` (alias `auth`) to add credentials, and `axiomsec models` to list and refresh.

The bet is not that one model magically solves security. The bet is that good models become much more useful when they work inside the right environment.

## Repository layout

This is a Bun + Turbo workspace. Source is split by responsibility, not by feature trees:

```
packages/
├── axiomsec/          terminal app, agent runtime, tools, server, CLI
│   └── src/
│       ├── acp/             ACP (Agent Client Protocol) server + agent
│       ├── agent/           agents and system prompts
│       ├── auth/            credentials and token storage
│       ├── browser/         headless browser surface
│       ├── cli/             CLI entrypoints + TUI
│       ├── commands/        built-in slash command templates
│       ├── config/          user config schema and migrations
│       ├── core/            cyber kernel: operations, plans, evidence,
│       │                    findings, replay, knowledge, methodology
│       ├── effect/          Effect runtime layers
│       ├── env/             environment detection
│       ├── events/          event bus
│       ├── files/           file IO and ripgrep worker
│       ├── flags/           feature flags
│       ├── formatters/      output formatters
│       ├── git/             git integration
│       ├── globals/         process-level globals
│       ├── identifier/      ULID-based ids
│       ├── installer/       version + update channel
│       ├── mcp/             MCP server management
│       ├── npm/             npm registry helpers
│       ├── patches/         patch apply/preview
│       ├── permissions/     tool permission engine
│       ├── plugins/         plugin loader
│       ├── project/         instance + bootstrap
│       ├── providers/       AI provider registry, transforms, copilot SDK
│       ├── question/        agent → user question protocol
│       ├── scanners/        port / dir / JS / form scanners
│       ├── server/          headless HTTP server
│       ├── session/         session, messages, todos
│       ├── shell/           shell parsing helpers
│       ├── skills/          skill registry
│       ├── snapshots/       workspace snapshots
│       ├── storage/         SQLite (Drizzle) + JSON migration
│       ├── support/         shared utilities (was util/)
│       ├── sync/            event replication
│       ├── terminal/        PTY surface (was pty/)
│       ├── tools/           agent tool implementations
│       ├── v2/              public SDK v2 surface
│       └── worktrees/       git worktree handling
├── sdk/                @axiomsec/sdk — typed client for the headless server
├── plugin/             @axiomsec/plugin — plugin API surface
├── shared/             @axiomsec/shared — utilities reused by all packages
└── script/             @axiomsec/script — internal build helpers
```

## Development

```bash
bun install
bun typecheck                 # turbo runs tsgo --noEmit across all packages
bun run lint                  # oxlint at the repo root
bun --cwd packages/axiomsec run dev
bun --cwd packages/axiomsec run build
```

Database tooling (Drizzle):

```bash
bun --cwd packages/axiomsec run db generate
bun --cwd packages/axiomsec run db migrate
```

Refresh the bundled provider/model snapshot:

```bash
bun --cwd packages/axiomsec run script/generate.ts
```

## Plugins and SDK

Build plugins against `@axiomsec/plugin` and integrate with a headless instance through `@axiomsec/sdk`.

A plugin is an async function that receives an `AxiomSec` client plus project context and returns a set of hooks:

```ts
import type { Plugin } from "@axiomsec/plugin"

export const example: Plugin = async ({ client, project, directory, $ }) => {
  return {
    event: async ({ event }) => {
      // Observe runtime events: session lifecycle, tool calls, findings, ...
    },
    "tool.execute.before": async (input, output) => {
      // Inspect or rewrite tool arguments before execution.
    },
    "tool.execute.after": async (input, output) => {
      // Annotate or forward tool output (e.g. to a SIEM).
    },
  }
}
```

A plugin can also contribute tools. They run through the same audit boundary as
the built-ins — validated arguments, ledger events, workflow progress — and
should declare the side effects they perform:

```ts
import { tool } from "@axiomsec/plugin"

export default tool({
  description: "Look up an internal asset inventory",
  args: { host: tool.schema.string() },
  side_effects: ["network"],
  async execute(args, ctx) {
    // ctx.ask(...) is available for permissioned actions.
    return await lookup(args.host)
  },
})
```

Drive a running headless server from any TypeScript program:

```ts
import { createAxiomSecClient } from "@axiomsec/sdk/v2"

const client = createAxiomSecClient({ baseUrl: "http://127.0.0.1:4096" })
const sessions = await client.session.list({ limit: 30 })
```

Install a plugin from npm or a local path:

```bash
axiomsec plugin <npm-package-or-path>
```

## Scope and honest limits

AxiomSec is built around a simple rule: **the agent can help you move faster, but the workflow should not let it overclaim.**

- Mature focus today: AppSec, Pentest.
- The findings lifecycle is deliberately rigid — weak signals stay weak, rejected claims remain visible, reportable findings need proof.
- Other cyber surfaces (OSINT, CTF/lab, cloud, container, IaC, binary triage) exist or are planned, but are not marketed as equally mature.
- AxiomSec does not replace authorization, operator judgment, manual review or specialized tools.

Use AxiomSec only for authorized security work, research, education and defensive operations.

## License

Released under the **GNU Affero General Public License v3.0 or later**. See [`NOTICE`](./NOTICE) for attribution and branding terms.
