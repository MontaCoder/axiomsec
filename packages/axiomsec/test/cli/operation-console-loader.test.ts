import { describe, expect, test } from "bun:test"
import { createOperationConsoleLoader } from "@/cli/cmd/tui/component/operation-lens/loader"
import type { OperationConsoleSnapshot } from "@/cli/cmd/tui/component/operation-lens/snapshot"

function snapshot(directory: string): OperationConsoleSnapshot {
  return {
    directory,
    evidenceCount: 0,
    evidenceEntries: [],
    timeline: [],
  }
}

describe("operation console loader", () => {
  test("coalesces concurrent views into one snapshot build", async () => {
    let builds = 0
    const loader = createOperationConsoleLoader(async (directory) => {
      builds += 1
      await Bun.sleep(20)
      return snapshot(directory)
    })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => loader("C:/workspace", { sessionID: "session" })),
    )
    expect(builds).toBe(1)
    expect(results.every((item) => item?.directory === "C:/workspace")).toBe(true)
  })

  test("serves a short-lived cached result and rebuilds after it expires", async () => {
    let builds = 0
    const loader = createOperationConsoleLoader(async (directory) => {
      builds += 1
      return snapshot(directory)
    }, 10)
    await loader("C:/workspace", { sessionID: "session" })
    await loader("C:/workspace", { sessionID: "session" })
    expect(builds).toBe(1)
    await Bun.sleep(20)
    await loader("C:/workspace", { sessionID: "session" })
    expect(builds).toBe(2)
  })

  test("keeps sessions separate and clears on operation attach", async () => {
    let builds = 0
    const loader = createOperationConsoleLoader(async (directory) => {
      builds += 1
      return snapshot(directory)
    })
    await loader("C:/workspace", { sessionID: "a" })
    await loader("C:/workspace", { sessionID: "b" })
    expect(builds).toBe(2)
    loader.clear()
    await loader("C:/workspace", { sessionID: "a" })
    expect(builds).toBe(3)
  })
})
