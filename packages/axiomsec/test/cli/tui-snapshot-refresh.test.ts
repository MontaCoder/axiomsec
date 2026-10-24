import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  sessionOperationSlug,
  shouldRefreshOperationConsoleSnapshotForPart,
  shouldRefreshOperationConsoleSnapshotForSession,
} from "@/cli/cmd/tui/component/operation-lens/snapshot"

const SRC = join(import.meta.dir, "..", "..", "src", "cli", "cmd", "tui")
const SNAPSHOT_CONSUMERS = [
  join(SRC, "component", "operation-banner.tsx"),
  join(SRC, "feature-plugins", "sidebar", "operation.tsx"),
  join(SRC, "feature-plugins", "sidebar", "activity.tsx"),
  join(SRC, "feature-plugins", "sidebar", "prompt-hints.tsx"),
  join(SRC, "routes", "session", "sidebar.tsx"),
]

describe("operation console refresh policy", () => {
  test("tool parts refresh only after completion or error", () => {
    expect(shouldRefreshOperationConsoleSnapshotForPart({ type: "tool", state: { status: "running" } })).toBe(false)
    expect(shouldRefreshOperationConsoleSnapshotForPart({ type: "tool", state: { status: "completed" } })).toBe(true)
    expect(shouldRefreshOperationConsoleSnapshotForPart({ type: "tool", state: { status: "error" } })).toBe(true)
    expect(shouldRefreshOperationConsoleSnapshotForPart({ type: "text" })).toBe(false)
  })

  test("session updates refresh only when the attached operation changes", () => {
    const base = { sessionID: "s1", currentSessionID: "s1" }
    expect(
      shouldRefreshOperationConsoleSnapshotForSession({ ...base, previousSlug: "a", nextSlug: "a" }),
    ).toBe(false)
    expect(
      shouldRefreshOperationConsoleSnapshotForSession({ ...base, previousSlug: "a", nextSlug: "b" }),
    ).toBe(true)
    expect(
      shouldRefreshOperationConsoleSnapshotForSession({ ...base, previousSlug: "a", nextSlug: null }),
    ).toBe(true)
    expect(
      shouldRefreshOperationConsoleSnapshotForSession({ ...base, previousSlug: undefined, nextSlug: undefined }),
    ).toBe(false)
    expect(
      shouldRefreshOperationConsoleSnapshotForSession({
        sessionID: "s2",
        currentSessionID: "s1",
        previousSlug: "a",
        nextSlug: "b",
      }),
    ).toBe(false)
  })

  test("reads the runtime operationSlug without trusting the SDK type", () => {
    expect(sessionOperationSlug({ operationSlug: "op" })).toBe("op")
    expect(sessionOperationSlug({ operationSlug: null })).toBeNull()
    expect(sessionOperationSlug({})).toBeUndefined()
    expect(sessionOperationSlug(undefined)).toBeUndefined()
    expect(sessionOperationSlug({ operationSlug: 42 })).toBeUndefined()
  })

  test("streaming status deltas never rebuild the operation console", async () => {
    for (const file of SNAPSHOT_CONSUMERS) {
      const source = await Bun.file(file).text()
      expect(source, `${file} must not refresh on session.status`).not.toContain('on("session.status"')
    }

    const sessionRoute = (await Bun.file(join(SRC, "routes", "session", "index.tsx")).text()).replaceAll("\r\n", "\n")
    const start = sessionRoute.indexOf('event.on("session.status"')
    expect(start).toBeGreaterThanOrEqual(0)
    const block = sessionRoute.slice(start, sessionRoute.indexOf("\n  })\n", start))
    expect(block).not.toContain("refreshSnapshot")
  })
})
