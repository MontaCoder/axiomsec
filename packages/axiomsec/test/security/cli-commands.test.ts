import { describe, expect, test } from "bun:test"
import { binaryPath, run, workspace } from "../support/harness"

const BIN = binaryPath()

describe.skipIf(!BIN)("read-only CLI commands", () => {
  test(
    "debug config prints the resolved model and provider",
    async () => {
      const ws = await workspace("cli-config")
      try {
        const result = await run(ws, ["debug", "config"])
        expect(result.code).toBe(0)
        const config = JSON.parse(result.stdout)
        expect(config.model).toBe("mock/mock-model")
        expect(config.provider.mock.name).toBe("Mock")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "models lists the configured model",
    async () => {
      const ws = await workspace("cli-models")
      try {
        const result = await run(ws, ["models"])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("mock/mock-model")
        const filtered = await run(ws, ["models", "mock"])
        expect(filtered.code).toBe(0)
        expect(filtered.stdout).toContain("mock/mock-model")
        expect(filtered.stdout).not.toContain("anthropic/")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "stats renders an empty workspace without failing",
    async () => {
      const ws = await workspace("cli-stats")
      try {
        const result = await run(ws, ["stats", "--project", ""])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("OVERVIEW")
        expect(result.stdout).toContain("Sessions")
        expect(result.stdout).toContain("0")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "providers list reports the credential surface",
    async () => {
      const ws = await workspace("cli-providers")
      try {
        const result = await run(ws, ["providers", "list"])
        expect(result.code).toBe(0)
        expect(result.stdout + result.stderr).toContain("credentials")
        // The mock provider is a custom config provider, not a models.dev
        // credential, so no environment section is expected here.
        expect(result.stdout + result.stderr).toContain("0 credentials")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "generate emits a valid OpenAPI document with the SDK-relevant paths",
    async () => {
      const ws = await workspace("cli-generate")
      try {
        const result = await run(ws, ["generate"])
        expect(result.code).toBe(0)
        const spec = JSON.parse(result.stdout)
        expect(spec.openapi).toMatch(/^3\./)
        expect(spec.info.title).toBeTruthy()
        expect(spec.paths["/config"]).toBeTruthy()
        expect(spec.paths["/session"]).toBeTruthy()
        expect(Object.keys(spec.paths).length).toBeGreaterThan(10)
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})
