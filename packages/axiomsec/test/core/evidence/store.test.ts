import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, open, readFile, rm, writeFile, appendFile } from "node:fs/promises"
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

  test("a large path artifact uses the streaming writer and still verifies", async () => {
    const { base, ws } = await workspace()
    const source = join(base, "streamed-artifact.bin")
    const handle = await open(source, "w")
    await handle.truncate(17 * 1024 * 1024)
    await handle.close()

    const entry = await Evidence.put(ws, "op", { path: source }, { ext: "bin" })
    expect(entry.size).toBe(17 * 1024 * 1024)
    expect(await Evidence.verify(ws, "op", entry.sha256)).toBe(true)

    const preview = await Evidence.get(ws, "op", entry.sha256, { maxBytes: 32 })
    expect(preview?.bytes.length).toBe(32)

    await rm(base, { recursive: true, force: true })
  })

  test("a path artifact is content-addressed and previews only the requested prefix", async () => {
    const { base, ws } = await workspace()
    const source = join(base, "large-artifact.bin")
    const content = Buffer.alloc(256 * 1024)
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251
    await writeFile(source, content)

    const entry = await Evidence.put(ws, "op", { path: source }, { ext: "bin" })
    expect(entry.size).toBe(content.length)
    expect(await Evidence.verify(ws, "op", entry.sha256)).toBe(true)

    const preview = await Evidence.get(ws, "op", entry.sha256, { maxBytes: 64 })
    expect(preview?.bytes.length).toBe(64)
    expect(Buffer.from(preview!.bytes).equals(content.subarray(0, 64))).toBe(true)

    const full = await Evidence.get(ws, "op", entry.sha256)
    expect(full?.bytes.length).toBe(content.length)
    expect(Buffer.from(full!.bytes).equals(content)).toBe(true)

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

describe("lock-free manifest listing", () => {
  test("a concurrent listing stays parseable and sees every committed entry", async () => {
    const { base, ws } = await workspace()
    const puts = Array.from({ length: 20 }, (_, index) => Evidence.put(ws, "op", `concurrent-${index}`, { ext: "txt" }))
    const reads: number[] = []
    for (let index = 0; index < 20; index++) {
      reads.push((await Evidence.list(ws, "op")).length)
      await Bun.sleep(1)
    }
    await Promise.all(puts)
    const final = await Evidence.list(ws, "op")
    expect(final.length).toBe(20)
    expect(reads.every((count) => count <= final.length)).toBe(true)
    await rm(base, { recursive: true, force: true })
  })

  test("get and verify stay correct while another writer appends", async () => {
    const { base, ws } = await workspace()
    const stable = await Evidence.put(ws, "op", "stable-entry", { ext: "txt" })
    const puts = Array.from({ length: 10 }, (_, index) => Evidence.put(ws, "op", `writer-${index}`, { ext: "txt" }))
    for (let index = 0; index < 10; index++) {
      expect((await Evidence.get(ws, "op", stable.sha256))?.bytes.length).toBe("stable-entry".length)
      expect(await Evidence.verify(ws, "op", stable.sha256)).toBe(true)
      await Bun.sleep(1)
    }
    await Promise.all(puts)
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
