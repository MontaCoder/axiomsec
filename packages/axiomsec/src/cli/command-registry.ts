import type { Argv, CommandModule } from "yargs"

type AnyCommand = CommandModule<any, any>

type LazyCommand = {
  command: string
  describe?: string
  aliases?: string[]
  load: () => Promise<AnyCommand>
}

/**
 * Defer a command module until yargs needs it.
 *
 * yargs runs a command's builder only when that command matches (or when help
 * renders the default command), so the invoked command is the only module
 * graph loaded at startup. The module promise is memoized because yargs calls
 * the builder and then the handler.
 */
export function lazyCommand(input: LazyCommand): AnyCommand {
  let loaded: Promise<AnyCommand> | undefined
  const load = () => (loaded ??= input.load())
  return {
    command: input.command,
    describe: input.describe,
    aliases: input.aliases,
    builder: async (yargs: Argv) => {
      const module = await load()
      const builder = module.builder as unknown
      if (typeof builder === "function") return await (builder as (args: Argv) => Argv | PromiseLike<Argv>)(yargs)
      if (builder && typeof builder === "object") return yargs.options(builder as Record<string, never>)
      return yargs
    },
    handler: async (args) => {
      const module = await load()
      return module.handler?.(args)
    },
  }
}

export const commands: AnyCommand[] = [
  lazyCommand({
    command: "acp",
    describe: "start ACP (Agent Client Protocol) server",
    load: () => import("./cmd/acp").then((module) => module.AcpCommand),
  }),
  lazyCommand({
    command: "mcp",
    describe: "manage MCP (Model Context Protocol) servers",
    load: () => import("./cmd/mcp").then((module) => module.McpCommand),
  }),
  lazyCommand({
    command: "$0 [project]",
    describe: "start axiomsec tui",
    load: () => import("./cmd/tui/thread").then((module) => module.TuiThreadCommand),
  }),
  lazyCommand({
    command: "attach <url>",
    describe: "attach to a running axiomsec server",
    load: () => import("./cmd/tui/attach").then((module) => module.AttachCommand),
  }),
  lazyCommand({
    command: "run [message..]",
    describe: "run axiomsec with a message",
    load: () => import("./cmd/run").then((module) => module.RunCommand),
  }),
  lazyCommand({
    command: "generate",
    load: () => import("./cmd/generate").then((module) => module.GenerateCommand),
  }),
  lazyCommand({
    command: "debug",
    describe: "debugging and troubleshooting tools",
    load: () => import("./cmd/debug").then((module) => module.DebugCommand),
  }),
  lazyCommand({
    command: "providers",
    aliases: ["auth"],
    describe: "manage AI providers and credentials",
    load: () => import("./cmd/providers").then((module) => module.ProvidersCommand),
  }),
  lazyCommand({
    command: "agent",
    describe: "manage agents",
    load: () => import("./cmd/agent").then((module) => module.AgentCommand),
  }),
  lazyCommand({
    command: "upgrade [target]",
    describe: "upgrade axiomsec to the latest or a specific version",
    load: () => import("./cmd/upgrade").then((module) => module.UpgradeCommand as AnyCommand),
  }),
  lazyCommand({
    command: "uninstall",
    describe: "uninstall axiomsec and remove all related files",
    load: () => import("./cmd/uninstall").then((module) => module.UninstallCommand as unknown as AnyCommand),
  }),
  lazyCommand({
    command: "serve",
    describe: "starts a headless axiomsec server",
    load: () => import("./cmd/serve").then((module) => module.ServeCommand),
  }),
  lazyCommand({
    command: "models [provider]",
    describe: "list all available models",
    load: () => import("./cmd/models").then((module) => module.ModelsCommand),
  }),
  lazyCommand({
    command: "stats",
    describe: "show token usage and cost statistics",
    load: () => import("./cmd/stats").then((module) => module.StatsCommand),
  }),
  lazyCommand({
    command: "export [sessionID]",
    describe: "export session data as JSON",
    load: () => import("./cmd/export").then((module) => module.ExportCommand),
  }),
  lazyCommand({
    command: "replay <command>",
    describe: "save and replay axiomsec engagements (.axiomsec files)",
    load: () => import("./cmd/replay").then((module) => module.ReplayCommand),
  }),
  lazyCommand({
    command: "pr <number>",
    describe: "fetch and checkout a GitHub PR branch, then run axiomsec",
    load: () => import("./cmd/pr").then((module) => module.PrCommand),
  }),
  lazyCommand({
    command: "session",
    describe: "manage sessions",
    load: () => import("./cmd/session").then((module) => module.SessionCommand),
  }),
  lazyCommand({
    command: "operation",
    aliases: ["op"],
    describe: "manage operations (engagements, reviews, investigations)",
    load: () => import("./cmd/operation").then((module) => module.OperationCommand),
  }),
  lazyCommand({
    command: "plugin <module>",
    aliases: ["plug"],
    describe: "install plugin and update config",
    load: () => import("./cmd/plugin").then((module) => module.PluginCommand),
  }),
  lazyCommand({
    command: "db",
    describe: "database tools",
    load: () => import("./cmd/db").then((module) => module.DbCommand),
  }),
]
