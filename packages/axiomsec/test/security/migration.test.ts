import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binaryPath, readDb, run, workspace } from "../support/harness"

const BIN = binaryPath()

describe.skipIf(!BIN)("legacy JSON to SQLite migration", () => {
  test(
    "imports projects, sessions, messages, parts, todos and permissions, and is idempotent",
    async () => {
      const ws = await workspace("json-migration")
      try {
        // Create the database without legacy storage, then add the fixture.
        const path = await run(ws, ["db", "path"])
        expect(path.code).toBe(0)
        const storage = join(ws.env.XDG_DATA_HOME, "axiomsec", "storage")
        const write = async (relative: string, data: unknown) => {
          const file = join(storage, relative)
          await mkdir(join(file, ".."), { recursive: true })
          await writeFile(file, JSON.stringify(data, null, 2))
        }
        await write("project/proj_legacy.json", {
          worktree: ws.dir,
          vcs: "git",
          name: "Legacy Project",
          time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
        })
        await write("session/proj_legacy/ses_legacy.json", {
          title: "Legacy Session",
          slug: "legacy",
          directory: ws.dir,
          version: "0.0.1",
          time: { created: 1_700_000_000_000, updated: 1_700_000_002_000 },
        })
        await write("message/ses_legacy/msg_legacy.json", {
          role: "user",
          agent: "security",
          model: { providerID: "mock", modelID: "mock-model" },
          time: { created: 1_700_000_000_000 },
        })
        await write("part/msg_legacy/prt_legacy.json", {
          type: "text",
          text: "LEGACY-TEXT",
        })
        await write("todo/ses_legacy.json", [
          { content: "legacy todo one", status: "pending", priority: "high" },
          { content: "legacy todo two", status: "completed", priority: "low" },
        ])
        await write("permission/proj_legacy.json", [{ permission: "bash", pattern: "*", action: "ask" }])

        const migrated = await run(ws, ["db", "migrate"])
        expect(migrated.code).toBe(0)
        expect(migrated.stderr).toContain("sqlite-migration:done")
        expect(migrated.stderr).toContain("Migration complete: 1 projects, 1 sessions, 1 messages")

        const counts = () => {
          const db = readDb(ws)
          try {
            const one = (table: string) =>
              (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
            return {
              projects: one("project"),
              sessions: one("session"),
              messages: one("message"),
              parts: one("part"),
              todos: one("todo"),
              permissions: one("permission"),
            }
          } finally {
            db.close()
          }
        }

        expect(counts()).toEqual({ projects: 1, sessions: 1, messages: 1, parts: 1, todos: 2, permissions: 1 })

        const db = readDb(ws)
        try {
          const session = db.query("SELECT title, directory FROM session WHERE id = 'ses_legacy'").get()
          expect(session).toMatchObject({ title: "Legacy Session", directory: ws.dir })
          const part = db.query("SELECT data FROM part WHERE id = 'prt_legacy'").get() as { data: string }
          expect(part.data).toContain("LEGACY-TEXT")
        } finally {
          db.close()
        }

        const second = await run(ws, ["db", "migrate"])
        expect(second.code).toBe(0)
        expect(counts()).toEqual({ projects: 1, sessions: 1, messages: 1, parts: 1, todos: 2, permissions: 1 })
      } finally {
        await ws.cleanup()
      }
    },
    120_000,
  )
})
