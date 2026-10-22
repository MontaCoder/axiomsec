import { existsSync, readdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Database } from "bun:sqlite"

const REPO = resolve(import.meta.dir, "../../../..")

/**
 * Locate the built binary. The integration and end-to-end layers run against
 * the real artifact rather than `bun src/index.ts`: the dev entry re-transpiles
 * on every start and is roughly twenty times slower, which makes a suite that
 * spawns the CLI impractical.
 *
 * Set AXIOMSEC_TEST_BIN to point at a specific build.
 */
export function binaryPath(): string | undefined {
  const explicit = process.env.AXIOMSEC_TEST_BIN
  if (explicit) return existsSync(explicit) ? explicit : undefined
  const dist = join(REPO, "packages", "axiomsec", "dist")
  if (!existsSync(dist)) return undefined
  for (const entry of readdirSync(dist)) {
    const bin = join(dist, entry, "bin", "axiomsec")
    if (existsSync(bin)) return bin
    const win = join(dist, entry, "bin", "axiomsec.exe")
    if (existsSync(win)) return win
  }
  return undefined
}

export function requireBinary(): string {
  const bin = binaryPath()
  if (!bin) {
    throw new Error(
      "No built binary found. Run `bun run --cwd packages/axiomsec build --single --skip-install` first, or set AXIOMSEC_TEST_BIN.",
    )
  }
  return bin
}

export type Workspace = {
  /** Absolute path to the disposable project directory. */
  dir: string
  /** Environment for every command run against this workspace. */
  env: Record<string, string>
  /** Remove the workspace and its state. */
  cleanup(): Promise<void>
}

/**
 * A provider configuration that resolves a default model without contacting
 * anything. The CLI resolves a model for most commands, so a test workspace
 * needs one; the end-to-end layer replaces the base URL with a live mock.
 */
export const MOCK_PROVIDER_CONFIG = {
  model: "mock/mock-model",
  provider: {
    mock: {
      id: "mock",
      name: "Mock",
      env: ["MOCK_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "mock" },
      models: {
        "mock-model": {
          name: "Mock",
          tool_call: true,
          limit: { context: 8192, output: 1024 },
          cost: { input: 0, output: 0 },
        },
      },
    },
  },
}

/**
 * Create a disposable workspace with its own XDG state, vault home and SQLite
 * database. Nothing a test writes can reach the developer's real state.
 */
export async function workspace(name = "case"): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), `axiomsec-${name}-`))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_STATE_HOME: join(dir, "state"),
    AXIOMSEC_DB: join(dir, "axiomsec.db"),
    AXIOMSEC_TEST_HOME: join(dir, "home"),
    AXIOMSEC_DISABLE_MODELS_FETCH: "1",
    AXIOMSEC_DISABLE_AUTOUPDATE: "1",
    AXIOMSEC_DISABLE_CLAUDE_CODE: "1",
    AXIOMSEC_CONFIG_CONTENT: JSON.stringify(MOCK_PROVIDER_CONFIG),
    MOCK_API_KEY: "mock",
    // Keep the CLI non-interactive so a test never blocks on a prompt.
    CI: "1",
  }
  return {
    dir,
    env,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export type RunResult = { code: number; stdout: string; stderr: string }

/** Run the CLI against a workspace and capture both streams. */
export async function run(ws: Workspace, args: string[], extraEnv?: Record<string, string>): Promise<RunResult> {
  const bin = requireBinary()
  const proc = Bun.spawn([bin, ...args], {
    cwd: ws.dir,
    env: { ...ws.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return { code: proc.exitCode ?? 0, stdout, stderr }
}

/** Read the cyber kernel for a workspace. The database is the canonical state. */
export function readDb(ws: Workspace): Database {
  return new Database(ws.env.AXIOMSEC_DB!, { readonly: true })
}

export type LedgerRow = {
  kind: string
  source: string
  status: string
  summary: string
  data: Record<string, unknown>
}

/** Every ledger event recorded for an operation, oldest first. */
export function ledger(ws: Workspace, slug: string): LedgerRow[] {
  const db = readDb(ws)
  try {
    const rows = db
      .query("SELECT kind, source, status, summary, data FROM cyber_ledger WHERE operation_slug = ? ORDER BY time_created, id")
      .all(slug) as Array<Omit<LedgerRow, "data"> & { data: string }>
    return rows.map((row) => ({ ...row, data: safeParse(row.data) }))
  } finally {
    db.close()
  }
}

export type FactRow = {
  entity_kind: string
  entity_key: string
  fact_name: string
  status: string
  value_json: Record<string, unknown>
}

/** Every fact recorded for an operation. */
export function facts(ws: Workspace, slug: string): FactRow[] {
  const db = readDb(ws)
  try {
    const rows = db
      .query(
        "SELECT entity_kind, entity_key, fact_name, status, value_json FROM cyber_fact WHERE operation_slug = ? ORDER BY time_created, id",
      )
      .all(slug) as Array<Omit<FactRow, "value_json"> & { value_json: string }>
    return rows.map((row) => ({ ...row, value_json: safeParse(row.value_json) }))
  } finally {
    db.close()
  }
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** The operation slug a workspace's active operation points at. */
export async function activeSlug(ws: Workspace): Promise<string | undefined> {
  const marker = join(ws.dir, ".axiomsec", "operation", "active")
  if (!existsSync(marker)) return undefined
  const slug = (await Bun.file(marker).text()).trim()
  return slug || undefined
}
