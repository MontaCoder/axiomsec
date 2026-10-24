import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { commands } from "./cli/command-registry"
import * as Log from "./support/log"
import { UI } from "./cli/ui"
import { InstallationLocal, InstallationVersion } from "./installer/version"
import { NamedError } from "@axiomsec/shared/util/error"
import { FormatError } from "./cli/error"
import * as Filesystem from "./support/filesystem"
import { EOL } from "os"
import { errorMessage } from "./support/error"
import { Heap } from "./cli/heap"

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("axiomsec ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const commandNames = new Set<string>()
for (const command of commands) {
  const name = String(command.command).split(/\s+/)[0]
  if (name && !name.startsWith("$") && name !== "*") commandNames.add(name)
  if (command.aliases) {
    for (const alias of Array.isArray(command.aliases) ? command.aliases : [command.aliases]) {
      commandNames.add(alias)
    }
  }
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("axiomsec")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    // Help only renders the command table. Do not create logs, scan for a
    // database, or run the one-time migration for it.
    if (opts.help || args.includes("-h") || args.includes("--help")) return

    if (opts.pure) {
      process.env.AXIOMSEC_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: InstallationLocal,
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (InstallationLocal) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.AXIOMSEC = "1"
    process.env.AXIOMSEC_PID = String(process.pid)

    Log.Default.info("axiomsec", {
      version: InstallationVersion,
      args: process.argv.slice(2),
    })

    // The JSON -> SQLite migration only needs to run once, and only when the
    // SQLite database does not exist yet. The marker is the resolved database
    // path: a hardcoded `Global.Path.data/axiomsec.db` missed the channel
    // suffix and `AXIOMSEC_DB`, so the migration re-ran on every command.
    // (RISK-PERSIST-06)
    const { Database } = await import("./storage")
    const marker = Database.Path
    if (marker !== ":memory:" && !(await Filesystem.exists(marker))) {
      const [{ JsonMigration }, { drizzle }] = await Promise.all([import("./storage"), import("drizzle-orm/bun-sqlite")])
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")

for (const command of commands) cli.command(command)

cli.fail((msg, err) => {
  if (
    msg?.startsWith("Unknown argument") ||
    msg?.startsWith("Not enough non-option arguments") ||
    msg?.startsWith("Invalid values:")
  ) {
    if (err) throw err
    cli.showHelp(show)
  }
  if (err) throw err
  process.exit(1)
}).strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    const hasCommand = args.some((arg) => !arg.startsWith("-") && commandNames.has(arg))
    if (!hasCommand) {
      // With async command builders yargs prints global help itself after the
      // parse callback, which the final process.exit() can discard on a piped
      // stdout. Render it explicitly instead.
      show(await cli.getHelp())
    } else {
      await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
        if (err) throw err
        if (!out) return
        show(out)
      })
    }
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
