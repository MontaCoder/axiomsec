import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Evidence from "@/core/evidence/store"

async function workspace() {
  const base = await mkdtemp(join(tmpdir(), "evidence-edge-"))
  const ws = join(base, "ws")
  await mkdir(ws, { recursive: true })
  return {
    ws,
    evidence: join(ws, ".axiomsec", "operation", "op", "evidence"),
    async cleanup() {
      await rm(base, { recursive: true, force: true })
    },
  }
}

describe("evidence metadata and naming", () => {
  test("a mime type chooses a stable extension", async () => {
    const { ws, cleanup } = await workspace()
    const cases: Array<[string, string]> = [
      ["text/plain; charset=utf-8", "txt"],
      ["application/json", "json"],
      ["image/png", "png"],
      ["application/pdf", "pdf"],
      ["application/x-tar", "bin"],
      ["application/vnd.tcpdump.pcap", "pcap"],
    ]
    for (const [mime, ext] of cases) {
      const entry = await Evidence.put(ws, "op", `${mime}-${ext}`, { mime })
      expect(entry.ext).toBe(ext)
    }
    await cleanup()
  })

  test("an explicit extension wins and leading dots are removed", async () => {
    const { ws, cleanup } = await workspace()
    const entry = await Evidence.put(ws, "op", "x", { ext: ".json" })
    expect(entry.ext).toBe("json")
    await cleanup()
  })

  test("metadata is preserved", async () => {
    const { ws, cleanup } = await workspace()
    const entry = await Evidence.put(ws, "op", "x", { mime: "text/plain", label: "canary", source: "test" })
    expect(entry).toMatchObject({ label: "canary", source: "test", mime: "text/plain", size: 1 })
    const fetched = await Evidence.get(ws, "op", entry.sha256)
    expect(fetched?.entry).toEqual(entry)
    expect(new TextDecoder().decode(fetched?.bytes)).toBe("x")
    await cleanup()
  })

  test("content-addressed writes are idempotent and keep the first metadata", async () => {
    const { ws, cleanup } = await workspace()
    const first = await Evidence.put(ws, "op", "same", { ext: "txt", label: "first" })
    const second = await Evidence.put(ws, "op", "same", { ext: "txt", label: "second" })
    expect(second).toEqual(first)
    expect((await Evidence.list(ws, "op")).length).toBe(1)
    await cleanup()
  })

  test("a hash prefix is not accepted as a ref", async () => {
    const { ws, cleanup } = await workspace()
    const entry = await Evidence.put(ws, "op", "x", { ext: "txt" })
    expect(await Evidence.verify(ws, "op", entry.sha256.slice(0, 16))).toBe(false)
    await cleanup()
  })
})

describe("evidence path containment (SEC-01)", () => {
  test("a hostile extension cannot add path segments", async () => {
    const { ws, evidence, cleanup } = await workspace()
    const entry = await Evidence.put(ws, "op", "payload", { ext: "../../../escaped" })
    expect(entry.ext).toBe("escaped")
    const stored = join(evidence, `${entry.sha256}.${entry.ext}`)
    expect((await stat(stored)).isFile()).toBe(true)
    await cleanup()
  })

  test("a hostile extension is stripped to a single token", async () => {
    const { ws, cleanup } = await workspace()
    for (const ext of ["../../x", "a/b", "a\\b", "..", "....", ""]) {
      const entry = await Evidence.put(ws, "op", `payload-${ext}`, { ext })
      expect(entry.ext).toMatch(/^[A-Za-z0-9]{1,16}$/)
    }
    await cleanup()
  })

  test("a hand-edited manifest with a traversal extension fails closed", async () => {
    const { ws, evidence, cleanup } = await workspace()
    const entry = await Evidence.put(ws, "op", "safe", { ext: "txt" })
    const manifest = join(evidence, "manifest.jsonl")
    const rows = (await readFile(manifest, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    rows[0].ext = "../../../outside"
    await writeFile(manifest, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
    expect(await Evidence.get(ws, "op", entry.sha256)).toBeUndefined()
    expect(await Evidence.verify(ws, "op", entry.sha256)).toBe(false)
    await cleanup()
  })
})

describe("concurrent evidence writes", () => {
  test("sixteen concurrent puts of the same bytes all succeed with one entry", async () => {
    const { ws, cleanup } = await workspace()
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () => Evidence.put(ws, "op", "race-canary", { ext: "txt" })),
    )
    const rejected = results.filter((item) => item.status === "rejected")
    expect(rejected).toEqual([])
    const entries = await Evidence.list(ws, "op")
    expect(entries).toHaveLength(1)
    expect(await Evidence.verify(ws, "op", entries[0].sha256)).toBe(true)
    await cleanup()
  })

  test("concurrent different bytes all appear", async () => {
    const { ws, cleanup } = await workspace()
    await Promise.all(Array.from({ length: 12 }, (_, index) => Evidence.put(ws, "op", `payload-${index}`, { ext: "txt" })))
    const entries = await Evidence.list(ws, "op")
    expect(entries).toHaveLength(12)
    for (const entry of entries) expect(await Evidence.verify(ws, "op", entry.sha256)).toBe(true)
    await cleanup()
  })
})
