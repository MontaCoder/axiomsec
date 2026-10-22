import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binaryPath, readDb, requireBinary, run, workspace, type Workspace } from "../support/harness"
import { mockConfig, mockProvider } from "../support/provider"

const BIN = binaryPath()

async function createOperation(ws: Workspace) {
  const result = await run(ws, [
    "operation",
    "new",
    "Serve Replay",
    "--kind",
    "pentest",
    "--target",
    "http://127.0.0.1:18080",
  ])
  expect(result.code).toBe(0)
  return /created ([a-z0-9-]+) \[/.exec(result.stdout + result.stderr)?.[1]
}

async function latestSession(ws: Workspace): Promise<string> {
  const db = readDb(ws)
  try {
    const row = db.query("SELECT id FROM session ORDER BY time_created DESC LIMIT 1").get() as { id: string } | null
    expect(row?.id).toBeTruthy()
    return row!.id
  } finally {
    db.close()
  }
}

async function waitForLine(stream: ReadableStream<Uint8Array>, timeoutMs = 30_000): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, remaining)),
        ),
      ])
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      const line = buffer.split(/\r?\n/).find((item) => item.includes("listening on"))
      if (line) return line
    }
  } finally {
    reader.releaseLock()
  }
  throw new Error(`server did not announce a listening address: ${buffer}`)
}

describe.skipIf(!BIN)("headless server security", () => {
  test(
    "a non-loopback bind without a password is refused before listening",
    async () => {
      const ws = await workspace("serve-refuse")
      try {
        const result = await run(ws, ["serve", "--hostname", "0.0.0.0"])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("refusing to bind 0.0.0.0 without AXIOMSEC_SERVER_PASSWORD")
        expect(result.stdout).not.toContain("listening on")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )

  test(
    "loopback requires Basic auth when a password is configured and rejects query tokens",
    async () => {
      const ws = await workspace("serve-auth")
      const password = "canary-password"
      const proc = Bun.spawn([requireBinary(), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: ws.dir,
        env: { ...ws.env, AXIOMSEC_SERVER_PASSWORD: password },
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        const line = await waitForLine(proc.stdout)
        const port = Number(/127\.0\.0\.1:(\d+)/.exec(line)?.[1])
        expect(port).toBeGreaterThan(0)
        const base = `http://127.0.0.1:${port}`

        const noAuth = await fetch(`${base}/config`, { signal: AbortSignal.timeout(10_000) })
        expect(noAuth.status).toBe(401)

        const queryAuth = await fetch(`${base}/config?auth_token=${Buffer.from(`axiomsec:${password}`).toString("base64")}`, {
          signal: AbortSignal.timeout(10_000),
        })
        expect(queryAuth.status).toBe(401)

        const basic = await fetch(`${base}/config`, {
          headers: { Authorization: `Basic ${Buffer.from(`axiomsec:${password}`).toString("base64")}` },
          signal: AbortSignal.timeout(10_000),
        })
        expect(basic.status).toBe(200)
        expect(await basic.text()).toContain("model")
      } finally {
        proc.kill()
        await proc.exited
        await ws.cleanup()
      }
    },
    90_000,
  )

  test(
    "loopback without a password warns and serves local requests",
    async () => {
      const ws = await workspace("serve-warn")
      const proc = Bun.spawn([requireBinary(), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: ws.dir,
        env: { ...ws.env, AXIOMSEC_SERVER_PASSWORD: "" },
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        const line = await waitForLine(proc.stdout)
        const port = Number(/127\.0\.0\.1:(\d+)/.exec(line)?.[1])
        expect(port).toBeGreaterThan(0)
        const response = await fetch(`http://127.0.0.1:${port}/config`, { signal: AbortSignal.timeout(10_000) })
        expect(response.status).toBe(200)
      } finally {
        proc.kill()
        await proc.exited
        await ws.cleanup()
      }
    },
    90_000,
  )
})

describe.skipIf(!BIN)("session export and replay", () => {
  test(
    "export sanitizes transcripts and replay save/verify/show round-trips",
    async () => {
      const ws = await workspace("replay-roundtrip")
      const provider = mockProvider([{ kind: "text", content: "Authorization: Bearer REPLAY-CANARY sensitive" }])
      try {
        await createOperation(ws)
        const runResult = await run(ws, ["run", "return a canary", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(runResult.code).toBe(0)
        const session = await latestSession(ws)

        const exported = await run(ws, ["export", session])
        expect(exported.code).toBe(0)
        expect(exported.stdout).toContain("REPLAY-CANARY")

        const sanitized = await run(ws, ["export", session, "--sanitize"])
        expect(sanitized.code).toBe(0)
        expect(sanitized.stdout).not.toContain("REPLAY-CANARY")
        expect(sanitized.stdout).toContain("[redacted:text:")
        JSON.parse(sanitized.stdout)

        const replayPath = join(ws.dir, "session.axiomsec")
        const saved = await run(ws, ["replay", "save", session, "--out", replayPath, "--redact"])
        expect(saved.code).toBe(0)
        expect(saved.stderr).toContain("Wrote")
        const text = await readFile(replayPath, "utf8")
        expect(text).toContain('"format":"axiomsec/1"')
        expect(text).not.toContain("REPLAY-CANARY")
        expect(text).toContain('"redacted":true')

        const verified = await run(ws, ["replay", "verify", replayPath])
        expect(verified.code).toBe(0)
        expect(verified.stderr).toContain("sha256: ok")
        expect(verified.stderr).toContain("signature: none")

        const shown = await run(ws, ["replay", "show", replayPath])
        expect(shown.code).toBe(0)
        expect(shown.stderr).toContain("integrity: ok")
        expect(shown.stderr).toContain("ASSISTANT")

        // A tampered body is detected by verify (exit 1) and reported by show.
        await writeFile(replayPath, text.replace('"redacted":true', '"redacted":false'))
        const tamperedVerify = await run(ws, ["replay", "verify", replayPath])
        expect(tamperedVerify.code).toBe(1)
        expect(tamperedVerify.stderr).toContain("sha256 mismatch")
        const tamperedShow = await run(ws, ["replay", "show", replayPath])
        expect(tamperedShow.code).toBe(0)
        expect(tamperedShow.stderr).toContain("integrity: MISMATCH")
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )

  test(
    "an unsigned replay with a forged signature is UNVERIFIED",
    async () => {
      const ws = await workspace("replay-forged")
      try {
        await createOperation(ws)
        const replayPath = join(ws.dir, "forged.axiomsec")
        const header = {
          type: "header",
          format: "axiomsec/1",
          id: "ses_forged",
          scope: "session",
          created_at: "2026-01-01T00:00:00.000Z",
          exported_at: "2026-01-01T00:00:00.000Z",
          axiomsec_version: "test",
          redacted: false,
        }
        const body = JSON.stringify(header) + "\n"
        // The trailer hash is computed over the header line; the signature is fake.
        const { createHash } = await import("node:crypto")
        const sha = createHash("sha256").update(body).digest("hex")
        const trailer = {
          type: "trailer",
          events: 0,
          duration_ms: 0,
          sha256_body: sha,
          signed: true,
          signature: { scheme: "minisign", value: Buffer.from("fake").toString("base64") },
        }
        await writeFile(replayPath, body + JSON.stringify(trailer) + "\n")
        const result = await run(ws, ["replay", "verify", replayPath])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("UNVERIFIED")
        expect(result.stderr).toContain("AXIOMSEC_MINISIGN_PUBKEY")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})

describe.skipIf(!BIN)("server session API", () => {
  test(
    "create, list, update and delete a session over the authenticated HTTP API",
    async () => {
      const ws = await workspace("server-session-api")
      const password = "api-password"
      const proc = Bun.spawn([requireBinary(), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: ws.dir,
        env: { ...ws.env, AXIOMSEC_SERVER_PASSWORD: password },
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        const line = await waitForLine(proc.stdout)
        const port = Number(/127\.0\.0\.1:(\d+)/.exec(line)?.[1])
        const base = `http://127.0.0.1:${port}`
        const headers = {
          Authorization: `Basic ${Buffer.from(`axiomsec:${password}`).toString("base64")}`,
          "content-type": "application/json",
        }

        const unauthenticated = await fetch(`${base}/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "unauth" }),
          signal: AbortSignal.timeout(10_000),
        })
        expect(unauthenticated.status).toBe(401)

        const created = await fetch(`${base}/session`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "API Session" }),
          signal: AbortSignal.timeout(10_000),
        })
        expect(created.status).toBe(200)
        const session = (await created.json()) as { id: string; title: string; parentID?: string }
        expect(session.id).toStartWith("ses_")
        expect(session.title).toBe("API Session")

        const listed = await fetch(`${base}/session?directory=${encodeURIComponent(ws.dir)}`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        })
        expect(listed.status).toBe(200)
        const sessions = (await listed.json()) as Array<{ id: string }>
        expect(sessions.some((item) => item.id === session.id)).toBe(true)

        const fetched = await fetch(`${base}/session/${session.id}`, { headers, signal: AbortSignal.timeout(10_000) })
        expect(fetched.status).toBe(200)
        expect(((await fetched.json()) as { title: string }).title).toBe("API Session")

        const updated = await fetch(`${base}/session/${session.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "Renamed API Session" }),
          signal: AbortSignal.timeout(10_000),
        })
        expect(updated.status).toBe(200)
        expect(((await updated.json()) as { title: string }).title).toBe("Renamed API Session")

        const forked = await fetch(`${base}/session/${session.id}/fork`, {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(10_000),
        })
        expect(forked.status).toBe(200)
        const child = (await forked.json()) as { id: string; parentID?: string; title: string }
        expect(child.id).not.toBe(session.id)
        expect(child.parentID).toBe(session.id)
        expect(child.title).toContain("fork")

        const children = await fetch(`${base}/session/${session.id}/children`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        })
        expect(children.status).toBe(200)
        expect(((await children.json()) as Array<{ id: string }>).map((item) => item.id)).toContain(child.id)

        // A fork must preserve the operator policy, not restart from defaults.
        const guarded = await fetch(`${base}/session`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Guarded",
            permission: [{ permission: "question", pattern: "*", action: "deny" }],
          }),
          signal: AbortSignal.timeout(10_000),
        })
        const guardedSession = (await guarded.json()) as { id: string }
        const guardedFork = await fetch(`${base}/session/${guardedSession.id}/fork`, {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(10_000),
        })
        const guardedChild = (await guardedFork.json()) as {
          parentID?: string
          permission?: Array<{ permission: string; pattern: string; action: string }>
        }
        expect(guardedChild.parentID).toBe(guardedSession.id)
        expect(guardedChild.permission).toContainEqual({ permission: "question", pattern: "*", action: "deny" })

        const deleted = await fetch(`${base}/session/${session.id}`, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(10_000),
        })
        expect(deleted.status).toBe(200)
        expect(await deleted.json()).toBe(true)

        const gone = await fetch(`${base}/session/${session.id}`, { headers, signal: AbortSignal.timeout(10_000) })
        expect(gone.status).toBe(404)
      } finally {
        proc.kill()
        await proc.exited
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("server message pagination and revert", () => {
  test(
    "pages messages and reverts/unreverts a completed session",
    async () => {
      const ws = await workspace("server-revert")
      const provider = mockProvider([{ kind: "text", content: "REVERT-ANSWER" }])
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
      try {
        await createOperation(ws)
        const runResult = await run(ws, ["run", "answer for revert", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(runResult.code).toBe(0)
        const sessionID = await latestSession(ws)

        const password = "revert-password"
        proc = Bun.spawn([requireBinary(), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
          cwd: ws.dir,
          env: { ...ws.env, AXIOMSEC_SERVER_PASSWORD: password },
          stdout: "pipe",
          stderr: "pipe",
        })
        const line = await waitForLine(proc.stdout)
        const port = Number(/127\.0\.0\.1:(\d+)/.exec(line)?.[1])
        const base = `http://127.0.0.1:${port}`
        const headers = {
          Authorization: `Basic ${Buffer.from(`axiomsec:${password}`).toString("base64")}`,
          "content-type": "application/json",
        }

        const all = await fetch(`${base}/session/${sessionID}/message`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        })
        expect(all.status).toBe(200)
        const messages = (await all.json()) as Array<{ info: { id: string; role: string } }>
        expect(messages.length).toBeGreaterThanOrEqual(2)

        const page = await fetch(`${base}/session/${sessionID}/message?limit=1`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        })
        expect(page.status).toBe(200)
        expect(((await page.json()) as unknown[]).length).toBe(1)
        const cursor = page.headers.get("x-next-cursor")
        expect(cursor).toBeTruthy()
        const older = await fetch(`${base}/session/${sessionID}/message?limit=1&before=${encodeURIComponent(cursor!)}`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        })
        expect(older.status).toBe(200)
        expect(((await older.json()) as unknown[]).length).toBe(1)

        const assistant = messages.find((message) => message.info.role === "assistant")
        expect(assistant).toBeTruthy()
        const reverted = await fetch(`${base}/session/${sessionID}/revert`, {
          method: "POST",
          headers,
          body: JSON.stringify({ messageID: assistant!.info.id }),
          signal: AbortSignal.timeout(20_000),
        })
        expect(reverted.status).toBe(200)
        const revertedSession = (await reverted.json()) as { revert?: { messageID: string } }
        expect(revertedSession.revert?.messageID).toBeTruthy()

        const restored = await fetch(`${base}/session/${sessionID}/unrevert`, {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(20_000),
        })
        expect(restored.status).toBe(200)
        expect(((await restored.json()) as { revert?: unknown }).revert).toBeUndefined()
      } finally {
        proc?.kill()
        await proc?.exited
        provider.close()
        await ws.cleanup()
      }
    },
    180_000,
  )
})

describe.skipIf(!BIN)("session CLI and stats", () => {
  test(
    "list, aggregate and delete a real session",
    async () => {
      const ws = await workspace("session-cli")
      const provider = mockProvider([{ kind: "text", content: "SESSION-CLI-ANSWER" }])
      try {
        await createOperation(ws)
        const runResult = await run(ws, ["run", "answer the session test", "--format", "json"], {
          AXIOMSEC_CONFIG_CONTENT: JSON.stringify(mockConfig(provider.baseURL)),
          MOCK_API_KEY: "mock",
        })
        expect(runResult.code).toBe(0)
        const session = await latestSession(ws)

        const listed = await run(ws, ["session", "list", "--format", "json"])
        expect(listed.code).toBe(0)
        const sessions = JSON.parse(listed.stdout)
        expect(sessions).toHaveLength(1)
        expect(sessions[0].id).toBe(session)
        expect(sessions[0].title).toBeTruthy()

        const stats = await run(ws, ["stats", "--project", ""])
        expect(stats.code).toBe(0)
        expect(stats.stdout).toContain("Sessions")
        expect(stats.stdout).toMatch(/Sessions\s+1/)
        expect(stats.stdout).toContain("Messages")
        expect(stats.stdout).toMatch(/Messages\s+[1-9]/)

        const missing = await run(ws, ["session", "delete", "ses_does_not_exist"])
        expect(missing.code).toBe(1)
        expect(missing.stderr).toContain("Session not found")

        const deleted = await run(ws, ["session", "delete", session])
        expect(deleted.code).toBe(0)
        expect(deleted.stderr).toContain("deleted")
        const after = await run(ws, ["session", "list", "--format", "json"])
        expect(after.code).toBe(0)
        expect(JSON.parse(after.stdout)).toEqual([])
      } finally {
        provider.close()
        await ws.cleanup()
      }
    },
    120_000,
  )
})

describe.skipIf(!BIN)("database CLI", () => {
  test(
    "path prints the workspace database and query supports json",
    async () => {
      const ws = await workspace("db-cli")
      try {
        await createOperation(ws)
        const path = await run(ws, ["db", "path"])
        expect(path.code).toBe(0)
        expect(path.stdout.trim()).toBe(ws.env.AXIOMSEC_DB)

        const query = await run(ws, ["db", "select count(*) as n from cyber_fact", "--format", "json"])
        expect(query.code).toBe(0)
        const rows = JSON.parse(query.stdout)
        expect(rows[0].n).toBeGreaterThanOrEqual(2)

        const bad = await run(ws, ["db", "select * from table_that_does_not_exist"])
        expect(bad.code).toBe(1)
        expect(bad.stderr).toContain("Error:")
      } finally {
        await ws.cleanup()
      }
    },
    60_000,
  )
})
