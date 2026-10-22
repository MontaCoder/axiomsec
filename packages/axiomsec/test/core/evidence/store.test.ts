import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Evidence from "@/core/evidence/store"

async function workspace() {
  const base = await mkdtemp(join(tmpdir(), "evidence-test-"))
  const ws = join(base, "ws")
  await mkdir(ws, { recursive: true })
  return { base, ws }
}

const manifestPath = (ws: string, slug = "op") => join(ws, ".axiomsec", "operation", slug, "evidence", "manifest.jsonl")

describe("evidence manifest tolerance (RISK-PERSIST-05)", () => {
  test("a corrupt line does not brick the locker", async () => {
    const { base, ws } = await workspace()
    const entry = await Evidence.put(ws, "op", "first", { ext: "txt" })
    await appendFile(manifestPath(ws), "TORN LINE NOT JSON\n")

    const listed = await Evidence.list(ws, "op")
    expect(listed.length).toBe(1)
    expect(listed[0]?.sha256).toBe(entry.sha256)

    // New evidence can still be written.
    const second = await Evidence.put(ws, "op", "second", { ext: "txt" })
    expect(second.sha256).toBeTruthy()
    expect((await Evidence.list(ws, "op")).length).toBe(2)

    await rm(base, { recursive: true, force: true })
  })

  test("a corrupt line does not break verification of a good ref", async () => {
    const { base, ws } = await workspace()
    const entry = await Evidence.put(ws, "op", "first", { ext: "txt" })
    await appendFile(manifestPath(ws), "{not json}\n")

    expect(await Evidence.verify(ws, "op", entry.sha256)).toBe(true)
    expect(await Evidence.verify(ws, "op", "a".repeat(64))).toBe(false)

    await rm(base, { recursive: true, force: true })
  })

  test("a truncated manifest still yields the entries written before it", async () => {
    const { base, ws } = await workspace()
    const entry = await Evidence.put(ws, "op", "first", { ext: "txt" })
    const raw = await readFile(manifestPath(ws), "utf8")
    await writeFile(manifestPath(ws), raw.slice(0, raw.length - 5))

    const listed = await Evidence.list(ws, "op")
    expect(listed.length).toBeLessThanOrEqual(1)
    if (listed.length === 1) expect(listed[0]?.sha256).toBe(entry.sha256)

    await rm(base, { recursive: true, force: true })
  })
})

describe("evidence content addressing (SEC-04)", () => {
  test("the same bytes produce the same digest and one manifest line", async () => {
    const { base, ws } = await workspace()
    const a = await Evidence.put(ws, "op", "same-canary", { ext: "txt" })
    const b = await Evidence.put(ws, "op", "same-canary", { ext: "txt" })
    expect(a.sha256).toBe(b.sha256)
    const raw = await readFile(manifestPath(ws), "utf8")
    expect(raw.trim().split("\n").filter(Boolean).length).toBe(1)
    await rm(base, { recursive: true, force: true })
  })

  test("the stored bytes re-hash to the digest", async () => {
    const { base, ws } = await workspace()
    const entry = await Evidence.put(ws, "op", "canary", { ext: "txt" })
    expect(await Evidence.verify(ws, "op", entry.sha256)).toBe(true)
    await rm(base, { recursive: true, force: true })
  })

  test("a tampered artifact fails verification", async () => {
    const { base, ws } = await workspace()
    const entry = await Evidence.put(ws, "op", "canary", { ext: "txt" })
    const file = join(ws, ".axiomsec", "operation", "op", "evidence", `${entry.sha256}.txt`)
    await writeFile(file, "tampered")
    expect(await Evidence.verify(ws, "op", entry.sha256)).toBe(false)
    await rm(base, { recursive: true, force: true })
  })
})

describe("evidence path containment (RISK-SCOPE-07)", () => {
  test("a traversal slug is refused instead of writing outside the operation tree", async () => {
    const { base, ws } = await workspace()
    await expect(Evidence.put(ws, "../..", "escape", { ext: "txt" })).rejects.toThrow(/Invalid operation slug/)
    await rm(base, { recursive: true, force: true })
  })
})
