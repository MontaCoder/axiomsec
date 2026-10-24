import { describe, expect, test } from "bun:test"
import type { Argv, CommandModule } from "yargs"
import yargs from "yargs"

type AnyCommand = CommandModule<any, any>

function aliases(value: AnyCommand["aliases"]): string[] {
  if (!value) return []
  return (Array.isArray(value) ? value : [value]).slice().sort()
}

describe("lazy command registry", () => {
  test("keeps the registered command surface in sync with the real modules", async () => {
    process.env.AXIOMSEC_DISABLE_MODELS_FETCH = "1"
    const [{ commands }, acp, mcp, thread, attach, run, generate, debug, providers, agent, upgrade, uninstall, serve, models, stats, exportCommand, replay, pr, session, operation, plugin, db] =
      await Promise.all([
        import("@/cli/command-registry"),
        import("@/cli/cmd/acp"),
        import("@/cli/cmd/mcp"),
        import("@/cli/cmd/tui/thread"),
        import("@/cli/cmd/tui/attach"),
        import("@/cli/cmd/run"),
        import("@/cli/cmd/generate"),
        import("@/cli/cmd/debug"),
        import("@/cli/cmd/providers"),
        import("@/cli/cmd/agent"),
        import("@/cli/cmd/upgrade"),
        import("@/cli/cmd/uninstall"),
        import("@/cli/cmd/serve"),
        import("@/cli/cmd/models"),
        import("@/cli/cmd/stats"),
        import("@/cli/cmd/export"),
        import("@/cli/cmd/replay"),
        import("@/cli/cmd/pr"),
        import("@/cli/cmd/session"),
        import("@/cli/cmd/operation"),
        import("@/cli/cmd/plugin"),
        import("@/cli/cmd/db"),
      ])

    const real: AnyCommand[] = [
      acp.AcpCommand,
      mcp.McpCommand,
      thread.TuiThreadCommand,
      attach.AttachCommand,
      run.RunCommand,
      generate.GenerateCommand as AnyCommand,
      debug.DebugCommand,
      providers.ProvidersCommand,
      agent.AgentCommand,
      upgrade.UpgradeCommand as AnyCommand,
      uninstall.UninstallCommand as unknown as AnyCommand,
      serve.ServeCommand,
      models.ModelsCommand,
      stats.StatsCommand,
      exportCommand.ExportCommand as AnyCommand,
      replay.ReplayCommand,
      pr.PrCommand,
      session.SessionCommand,
      operation.OperationCommand,
      plugin.PluginCommand,
      db.DbCommand,
    ]

    expect(commands).toHaveLength(real.length)
    for (const module of real) {
      const entry = commands.find((command) => command.command === module.command)
      expect(entry, `missing registry entry for ${String(module.command)}`).toBeDefined()
      expect(entry?.describe).toBe(module.describe)
      expect(aliases(entry?.aliases)).toEqual(aliases(module.aliases))
    }
  })

  test("loads a command once and delegates builder and handler", async () => {
    let loads = 0
    let handled: unknown
    const module: AnyCommand = {
      command: "example",
      describe: "example command",
      builder: (args) => args.option("flag", { type: "boolean" }),
      handler: (args) => {
        handled = args
      },
    }
    const { lazyCommand } = await import("@/cli/command-registry")
    const lazy = lazyCommand({
      command: "example",
      describe: "example command",
      load: async () => {
        loads += 1
        return module
      },
    })

    const built = await (lazy.builder as (args: Argv) => Promise<Argv>)(yargs([]))
    expect(built).toBeDefined()
    await lazy.handler?.({ flag: true, _: [], $0: "axiomsec" })
    expect(loads).toBe(1)
    expect(handled).toMatchObject({ flag: true })
  })
})
