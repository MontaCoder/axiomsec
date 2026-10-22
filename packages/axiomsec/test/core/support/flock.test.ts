import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { Flock } from "@axiomsec/shared/util/flock"

function lockDir(state: string, key: string) {
  return join(state, "locks", createHash("sha1").update(key).digest("hex") + ".lock")
}

async function fixture(pid: number, host = hostname()) {
  const state = await mkdtemp(join(tmpdir(), "flock-test-"))
  const key = "test-lock"
  const dir = lockDir(state, key)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "heartbeat"), "")
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ token: "owner-token", pid, hostname: host, createdAt: new Date().toISOString() }),
  )
  Flock.setGlobal({ state })
  return { state, key, dir }
}

describe("flock stale owner recovery (RISK-PERSIST-10)", () => {
  test("a lock owned by a dead PID is immediately recoverable", async () => {
    // PID 2^31-1 is not a valid live process on any supported platform.
    const { state, key, dir } = await fixture(2_147_483_647)
    try {
      const started = Date.now()
      const lease = await Flock.acquire(key, { staleMs: 60_000, timeoutMs: 2_000, baseDelayMs: 10 })
      expect(Date.now() - started).toBeLessThan(1_500)
      await lease.release()
      expect(await Bun.file(join(dir, "meta.json")).exists()).toBe(false)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a lock owned by this live process still blocks another contender", async () => {
    const { state, key, dir } = await fixture(process.pid)
    try {
      await expect(
        Flock.acquire(key, { staleMs: 60_000, timeoutMs: 300, baseDelayMs: 10 }),
      ).rejects.toThrow(/Timed out waiting for lock/)
      expect(await Bun.file(join(dir, "meta.json")).exists()).toBe(true)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a lock from another host is not stolen on PID evidence alone", async () => {
    const { state, key } = await fixture(2_147_483_647, "another-host.invalid")
    try {
      await expect(
        Flock.acquire(key, { staleMs: 60_000, timeoutMs: 300, baseDelayMs: 10 }),
      ).rejects.toThrow(/Timed out waiting for lock/)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("a live owner blocks and the lock is cleanly released afterwards", async () => {
    const state = await mkdtemp(join(tmpdir(), "flock-test-"))
    const key = "test-lock"
    const dir = lockDir(state, key)
    Flock.setGlobal({ state })
    try {
      const first = await Flock.acquire(key, { staleMs: 60_000, timeoutMs: 1_000 })
      await expect(
        Flock.acquire(key, { staleMs: 60_000, timeoutMs: 200, baseDelayMs: 10 }),
      ).rejects.toThrow(/Timed out/)
      await first.release()
      const second = await Flock.acquire(key, { staleMs: 60_000, timeoutMs: 1_000 })
      await second.release()
      expect(await Bun.file(join(dir, "meta.json")).exists()).toBe(false)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})
