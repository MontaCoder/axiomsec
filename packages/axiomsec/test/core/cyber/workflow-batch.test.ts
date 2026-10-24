import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..", "..")

describe("batched workflow progress", () => {
  test(
    "writes one row per fact, matching projection ids, and rolls back a failed batch",
    async () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, "test/fixtures/workflow-batch.ts"],
        cwd: ROOT,
        env: {
          ...process.env,
          AXIOMSEC_DISABLE_MODELS_FETCH: "1",
          AXIOMSEC_DISABLE_AUTOUPDATE: "1",
          AXIOMSEC_DISABLE_TELEMETRY: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = result.stdout.toString()
      if (result.exitCode !== 0) {
        throw new Error(`fixture failed (${result.exitCode}): ${result.stderr.toString()}\n${stdout}`)
      }
      const parsed = JSON.parse(stdout.trim()) as {
        ok: boolean
        rolledBack: boolean
        workflowFacts: number
        uniqueKeys: number
        projectionRecords: number
        missingIds: number
      }
      expect(parsed.rolledBack).toBe(true)
      expect(parsed.missingIds).toBe(0)
      expect(parsed.workflowFacts).toBe(21)
      expect(parsed.uniqueKeys).toBe(21)
      expect(parsed.projectionRecords).toBe(42)
      expect(parsed.ok).toBe(true)
    },
    90_000,
  )
})
