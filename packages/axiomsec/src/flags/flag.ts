import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

export namespace Flag {
  export const OTEL_EXPORTER_OTLP_ENDPOINT = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  export const OTEL_EXPORTER_OTLP_HEADERS = process.env["OTEL_EXPORTER_OTLP_HEADERS"]

  export const AXIOMSEC_AUTO_SHARE = truthy("AXIOMSEC_AUTO_SHARE")
  export const AXIOMSEC_AUTO_HEAP_SNAPSHOT = truthy("AXIOMSEC_AUTO_HEAP_SNAPSHOT")
  export const AXIOMSEC_GIT_BASH_PATH = process.env["AXIOMSEC_GIT_BASH_PATH"]
  export const AXIOMSEC_CONFIG = process.env["AXIOMSEC_CONFIG"]
  export declare const AXIOMSEC_PURE: boolean
  export declare const AXIOMSEC_TUI_CONFIG: string | undefined
  export declare const AXIOMSEC_CONFIG_DIR: string | undefined
  export declare const AXIOMSEC_PLUGIN_META_FILE: string | undefined
  export const AXIOMSEC_CONFIG_CONTENT = process.env["AXIOMSEC_CONFIG_CONTENT"]
  export const AXIOMSEC_DISABLE_AUTOUPDATE = truthy("AXIOMSEC_DISABLE_AUTOUPDATE")
  export const AXIOMSEC_ALWAYS_NOTIFY_UPDATE = truthy("AXIOMSEC_ALWAYS_NOTIFY_UPDATE")
  export const AXIOMSEC_DISABLE_PRUNE = truthy("AXIOMSEC_DISABLE_PRUNE")
  export const AXIOMSEC_DISABLE_TERMINAL_TITLE = truthy("AXIOMSEC_DISABLE_TERMINAL_TITLE")
  export const AXIOMSEC_SHOW_TTFD = truthy("AXIOMSEC_SHOW_TTFD")
  export const AXIOMSEC_PERMISSION = process.env["AXIOMSEC_PERMISSION"]
  export const AXIOMSEC_DISABLE_DEFAULT_PLUGINS = truthy("AXIOMSEC_DISABLE_DEFAULT_PLUGINS")
  export const AXIOMSEC_DISABLE_LSP_DOWNLOAD = truthy("AXIOMSEC_DISABLE_LSP_DOWNLOAD")
  export const AXIOMSEC_ENABLE_EXPERIMENTAL_MODELS = truthy("AXIOMSEC_ENABLE_EXPERIMENTAL_MODELS")
  export const AXIOMSEC_DISABLE_AUTOCOMPACT = truthy("AXIOMSEC_DISABLE_AUTOCOMPACT")
  export const AXIOMSEC_DISABLE_MODELS_FETCH = truthy("AXIOMSEC_DISABLE_MODELS_FETCH")
  export const AXIOMSEC_DISABLE_MOUSE = truthy("AXIOMSEC_DISABLE_MOUSE")
  export const AXIOMSEC_DISABLE_CLAUDE_CODE = truthy("AXIOMSEC_DISABLE_CLAUDE_CODE")
  export const AXIOMSEC_DISABLE_CLAUDE_CODE_PROMPT =
    AXIOMSEC_DISABLE_CLAUDE_CODE || truthy("AXIOMSEC_DISABLE_CLAUDE_CODE_PROMPT")
  export const AXIOMSEC_DISABLE_CLAUDE_CODE_SKILLS =
    AXIOMSEC_DISABLE_CLAUDE_CODE || truthy("AXIOMSEC_DISABLE_CLAUDE_CODE_SKILLS")
  export const AXIOMSEC_DISABLE_EXTERNAL_SKILLS =
    AXIOMSEC_DISABLE_CLAUDE_CODE_SKILLS || truthy("AXIOMSEC_DISABLE_EXTERNAL_SKILLS")
  export declare const AXIOMSEC_DISABLE_PROJECT_CONFIG: boolean
  export const AXIOMSEC_FAKE_VCS = process.env["AXIOMSEC_FAKE_VCS"]
  export declare const AXIOMSEC_CLIENT: string
  export const AXIOMSEC_SERVER_PASSWORD = process.env["AXIOMSEC_SERVER_PASSWORD"]
  export const AXIOMSEC_SERVER_USERNAME = process.env["AXIOMSEC_SERVER_USERNAME"]
  export const AXIOMSEC_ENABLE_QUESTION_TOOL = truthy("AXIOMSEC_ENABLE_QUESTION_TOOL")

  // Experimental
  export const AXIOMSEC_EXPERIMENTAL = truthy("AXIOMSEC_EXPERIMENTAL")
  export const AXIOMSEC_EXPERIMENTAL_FILEWATCHER = Config.boolean("AXIOMSEC_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  )
  export const AXIOMSEC_EXPERIMENTAL_DISABLE_FILEWATCHER = Config.boolean(
    "AXIOMSEC_EXPERIMENTAL_DISABLE_FILEWATCHER",
  ).pipe(Config.withDefault(false))
  export const AXIOMSEC_EXPERIMENTAL_ICON_DISCOVERY =
    AXIOMSEC_EXPERIMENTAL || truthy("AXIOMSEC_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["AXIOMSEC_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const AXIOMSEC_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("AXIOMSEC_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const AXIOMSEC_ENABLE_EXA =
    truthy("AXIOMSEC_ENABLE_EXA") || AXIOMSEC_EXPERIMENTAL || truthy("AXIOMSEC_EXPERIMENTAL_EXA")
  export const AXIOMSEC_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("AXIOMSEC_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const AXIOMSEC_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("AXIOMSEC_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const AXIOMSEC_EXPERIMENTAL_OXFMT = AXIOMSEC_EXPERIMENTAL || truthy("AXIOMSEC_EXPERIMENTAL_OXFMT")
  export const AXIOMSEC_EXPERIMENTAL_LSP_TY = truthy("AXIOMSEC_EXPERIMENTAL_LSP_TY")
  export const AXIOMSEC_EXPERIMENTAL_LSP_TOOL = AXIOMSEC_EXPERIMENTAL || truthy("AXIOMSEC_EXPERIMENTAL_LSP_TOOL")
  export const AXIOMSEC_DISABLE_FILETIME_CHECK = Config.boolean("AXIOMSEC_DISABLE_FILETIME_CHECK").pipe(
    Config.withDefault(false),
  )
  export const AXIOMSEC_EXPERIMENTAL_PLAN_MODE = AXIOMSEC_EXPERIMENTAL || truthy("AXIOMSEC_EXPERIMENTAL_PLAN_MODE")
  export const AXIOMSEC_EXPERIMENTAL_MARKDOWN = !falsy("AXIOMSEC_EXPERIMENTAL_MARKDOWN")
  export const AXIOMSEC_MODELS_URL = process.env["AXIOMSEC_MODELS_URL"]
  export const AXIOMSEC_MODELS_PATH = process.env["AXIOMSEC_MODELS_PATH"]
  export const AXIOMSEC_DISABLE_EMBEDDED_WEB_UI = truthy("AXIOMSEC_DISABLE_EMBEDDED_WEB_UI")
  export const AXIOMSEC_DB = process.env["AXIOMSEC_DB"]
  export const AXIOMSEC_DISABLE_CHANNEL_DB = truthy("AXIOMSEC_DISABLE_CHANNEL_DB")
  export const AXIOMSEC_SKIP_MIGRATIONS = truthy("AXIOMSEC_SKIP_MIGRATIONS")
  export const AXIOMSEC_STRICT_CONFIG_DEPS = truthy("AXIOMSEC_STRICT_CONFIG_DEPS")

  export const AXIOMSEC_WORKSPACE_ID = process.env["AXIOMSEC_WORKSPACE_ID"]
  export const AXIOMSEC_EXPERIMENTAL_HTTPAPI = AXIOMSEC_EXPERIMENTAL || truthy("AXIOMSEC_EXPERIMENTAL_HTTPAPI")
  export const AXIOMSEC_EXPERIMENTAL_WORKSPACES = AXIOMSEC_EXPERIMENTAL || truthy("AXIOMSEC_EXPERIMENTAL_WORKSPACES")

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for AXIOMSEC_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "AXIOMSEC_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("AXIOMSEC_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AXIOMSEC_TUI_CONFIG
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "AXIOMSEC_TUI_CONFIG", {
  get() {
    return process.env["AXIOMSEC_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AXIOMSEC_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "AXIOMSEC_CONFIG_DIR", {
  get() {
    return process.env["AXIOMSEC_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AXIOMSEC_PURE
// This must be evaluated at access time, not module load time,
// because the CLI can set this flag at runtime
Object.defineProperty(Flag, "AXIOMSEC_PURE", {
  get() {
    return truthy("AXIOMSEC_PURE")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AXIOMSEC_PLUGIN_META_FILE
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "AXIOMSEC_PLUGIN_META_FILE", {
  get() {
    return process.env["AXIOMSEC_PLUGIN_META_FILE"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AXIOMSEC_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "AXIOMSEC_CLIENT", {
  get() {
    return process.env["AXIOMSEC_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
