import { appendFile, mkdir, open, readFile, writeFile, stat, rename, rm } from "fs/promises"
import { createReadStream, createWriteStream } from "node:fs"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createHash } from "crypto"
import path from "path"
import { z } from "zod"
import { withFileLock } from "@/support/lock"
import { containedPath } from "../operation/slug"
import { Log } from "@/support"

const log = Log.create({ service: "evidence" })

export const Entry = z.object({
  sha256: z.string(),
  ext: z.string(),
  size: z.number(),
  mime: z.string().optional(),
  label: z.string().optional(),
  source: z.string().optional(),
  at: z.number(),
})
export type Entry = z.infer<typeof Entry>

const MANIFEST = "manifest.jsonl"
const DIR_NAME = "evidence"

function evidenceDir(workspace: string, slug: string): string {
  // The evidence locker is created on demand, so it is the most dangerous path
  // primitive in the operation tree: refuse any slug that could land outside
  // `.axiomsec/operation/`. (SEC-01 / RISK-SCOPE-07)
  const root = path.join(workspace, ".axiomsec", "operation")
  const dir = path.join(containedPath(root, slug), DIR_NAME)
  return dir
}

/**
 * Extensions are part of a filesystem name. Only a short alphanumeric token is
 * accepted so a malformed `ext` cannot add path segments or escape the evidence
 * directory. (SEC-01 / SEC-04)
 */
function safeExt(input?: string): string {
  const cleaned = (input ?? "")
    .replace(/^\.+/, "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 16)
  return cleaned || "bin"
}

/**
 * `path.extname` treats a dotfile such as `.env` as having no extension. A
 * dotfile is still a meaningful text artifact, so use its name as the token.
 */
function extFromPath(file: string): string | undefined {
  const ext = path.extname(file)
  if (ext) return ext
  const base = path.basename(file)
  return base.startsWith(".") && base.length > 1 ? base.slice(1) : undefined
}

function sniffExtFromMime(mime?: string): string {
  if (!mime) return "bin"
  const lower = mime.toLowerCase()
  if (lower.startsWith("text/html")) return "html"
  if (lower.startsWith("text/plain")) return "txt"
  if (lower.startsWith("text/markdown")) return "md"
  if (lower.startsWith("application/json")) return "json"
  if (lower.startsWith("image/png")) return "png"
  if (lower.startsWith("image/jpeg")) return "jpg"
  if (lower.startsWith("image/gif")) return "gif"
  if (lower.startsWith("image/webp")) return "webp"
  if (lower.startsWith("application/pdf")) return "pdf"
  if (lower.includes("har")) return "har"
  if (lower.includes("pcap")) return "pcap"
  return "bin"
}

type Manifest = {
  entries: Entry[]
  /** Lines that could not be parsed. They are skipped, not fatal. */
  malformed: number
}

/**
 * Read the evidence manifest.
 *
 * A single torn or hand-edited line must not brick the whole locker: the
 * remaining entries stay readable and new evidence can still be written. The
 * malformed count is surfaced so the damage is visible. (ENG-07 / RISK-PERSIST-05)
 */
function parseEntry(value: unknown): Entry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const sha256 = record["sha256"]
  const ext = record["ext"]
  const size = record["size"]
  const at = record["at"]
  if (typeof sha256 !== "string" || typeof ext !== "string") return undefined
  if (typeof size !== "number" || !Number.isFinite(size)) return undefined
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined
  const mime = record["mime"]
  const label = record["label"]
  const source = record["source"]
  if (mime !== undefined && typeof mime !== "string") return undefined
  if (label !== undefined && typeof label !== "string") return undefined
  if (source !== undefined && typeof source !== "string") return undefined
  return {
    sha256,
    ext,
    size,
    at,
    ...(mime !== undefined ? { mime } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(source !== undefined ? { source } : {}),
  }
}

function parseManifest(raw: string, slug: string, manifest: string): Manifest {
  if (!raw) return { entries: [], malformed: 0 }
  const entries: Entry[] = []
  let malformed = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = parseEntry(JSON.parse(line))
      if (entry) entries.push(entry)
      else malformed += 1
    } catch {
      malformed += 1
    }
  }
  if (malformed > 0) {
    log.warn("evidence manifest has malformed lines", { slug, malformed, manifest })
  }
  return { entries, malformed }
}

async function readManifest(workspace: string, slug: string): Promise<Manifest> {
  const p = path.join(evidenceDir(workspace, slug), MANIFEST)
  const raw = await readFile(p, "utf8").catch(() => "")
  return parseManifest(raw, slug, p)
}

/**
 * Read an append-only manifest without taking the write lock.
 *
 * A writer appends one line and never rewrites the file, so a read bracketed by
 * unchanged size/mtime is a consistent snapshot. A concurrent append makes the
 * stats differ and the read retries; after a few retries it falls back to the
 * locked reader. This removes a ~7 ms lock acquisition from every operation
 * snapshot while keeping writes and verification locked.
 */
async function readManifestStable(workspace: string, slug: string): Promise<Manifest> {
  const p = path.join(evidenceDir(workspace, slug), MANIFEST)
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await stat(p).catch(() => undefined)
    if (!before) return { entries: [], malformed: 0 }
    const raw = await readFile(p, "utf8").catch(() => "")
    const after = await stat(p).catch(() => undefined)
    if (!after) return parseManifest(raw, slug, p)
    if (after.size === before.size && after.mtimeMs === before.mtimeMs) {
      return parseManifest(raw, slug, p)
    }
  }
  return withFileLock(lockKey(workspace, slug), () => readManifest(workspace, slug))
}

function lockKey(workspace: string, slug: string) {
  return `evidence:${path.resolve(evidenceDir(workspace, slug))}`
}

export async function list(workspace: string, slug: string): Promise<Entry[]> {
  return (await readManifestStable(workspace, slug)).entries
}

async function findEntry(
  workspace: string,
  slug: string,
  sha256: string,
): Promise<{ entry: Entry; file: string } | undefined> {
  const { entries } = await readManifestStable(workspace, slug)
  const entry = entries.find((e) => e.sha256 === sha256)
  if (!entry) return undefined
  // A hand-edited manifest must not be able to redirect a read outside the
  // evidence directory. Fail closed when the stored extension is not a plain
  // token. (SEC-01)
  if (safeExt(entry.ext) !== entry.ext) return undefined
  return { entry, file: path.join(evidenceDir(workspace, slug), `${entry.sha256}.${entry.ext}`) }
}

export async function get(
  workspace: string,
  slug: string,
  sha256: string,
  options: { maxBytes?: number } = {},
): Promise<{ entry: Entry; bytes: Uint8Array } | undefined> {
  const found = await findEntry(workspace, slug, sha256)
  if (!found) return undefined
  const { entry, file } = found
  const info = await stat(file).catch(() => undefined)
  if (!info) return undefined

  // A preview only needs a prefix. Reading a multi-megabyte artifact to show
  // its first few kilobytes used to dominate evidence-get memory.
  if (options.maxBytes !== undefined && info.size > options.maxBytes) {
    const handle = await open(file, "r").catch(() => undefined)
    if (!handle) return undefined
    try {
      const size = Math.max(0, Math.min(Math.floor(options.maxBytes), info.size))
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, 0)
      return { entry, bytes: buffer.subarray(0, bytesRead) }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
  const bytes = await readFile(file).catch(() => undefined)
  if (!bytes) return undefined
  return { entry, bytes }
}

export async function verify(workspace: string, slug: string, sha256: string): Promise<boolean> {
  const found = await findEntry(workspace, slug, sha256)
  if (!found) return false
  const hasher = createHash("sha256")
  try {
    await pipeline(
      createReadStream(found.file),
      new Transform({
        transform(chunk, _encoding, callback) {
          hasher.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          callback()
        },
      }),
    )
  } catch {
    return false
  }
  return hasher.digest("hex") === sha256
}

async function record(
  workspace: string,
  slug: string,
  sha256: string,
  ext: string,
  size: number,
  meta: { mime?: string; label?: string; source?: string },
): Promise<Entry> {
  return withFileLock(lockKey(workspace, slug), async () => {
    const { entries: current } = await readManifest(workspace, slug)
    const existing = current.find((e) => e.sha256 === sha256)
    if (existing) return existing
    const entry: Entry = {
      sha256,
      ext,
      size,
      mime: meta.mime,
      label: meta.label,
      source: meta.source,
      at: Date.now(),
    }
    await appendFile(path.join(evidenceDir(workspace, slug), MANIFEST), JSON.stringify(entry) + "\n", "utf8")
    return entry
  })
}

const STREAM_THRESHOLD_BYTES = 16 * 1024 * 1024

async function putFile(
  workspace: string,
  slug: string,
  source: string,
  meta: { mime?: string; label?: string; source?: string; ext?: string },
  dir: string,
): Promise<Entry> {
  const ext = safeExt(meta.ext ?? (meta.mime ? sniffExtFromMime(meta.mime) : extFromPath(source)))
  const tmp = path.join(dir, `.incoming.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  const hasher = createHash("sha256")
  let size = 0
  try {
    // Hash and copy in one pass. Reading the whole source first used to
    // double the artifact in memory before the temp write.
    await pipeline(
      createReadStream(source),
      new Transform({
        transform(chunk, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          hasher.update(buffer)
          size += buffer.length
          callback(null, buffer)
        },
      }),
      createWriteStream(tmp),
    )
    const sha256 = hasher.digest("hex")
    const file = path.join(dir, `${sha256}.${ext}`)
    const existing = await stat(file).catch(() => undefined)
    if (existing) {
      await rm(tmp, { force: true })
    } else {
      await rename(tmp, file).catch(async (error: NodeJS.ErrnoException) => {
        if (await stat(file).catch(() => undefined)) {
          await rm(tmp, { force: true })
          return
        }
        throw error
      })
    }
    return await record(workspace, slug, sha256, ext, size, meta)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function put(
  workspace: string,
  slug: string,
  input: Uint8Array | string | { path: string },
  meta: { mime?: string; label?: string; source?: string; ext?: string } = {},
): Promise<Entry> {
  const dir = evidenceDir(workspace, slug)
  await mkdir(dir, { recursive: true })
  const source = typeof input === "object" && "path" in input ? input.path : undefined
  if (source) {
    const info = await stat(source).catch(() => undefined)
    if (info && info.size > STREAM_THRESHOLD_BYTES) return putFile(workspace, slug, source, meta, dir)
  }

  const bytes =
    input instanceof Uint8Array
      ? Buffer.from(input)
      : typeof input === "string"
        ? Buffer.from(input, "utf8")
        : await readFile(source!)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const ext = safeExt(meta.ext ?? (meta.mime ? sniffExtFromMime(meta.mime) : source ? extFromPath(source) : "bin"))
  const file = path.join(dir, `${sha256}.${ext}`)

  const existing = await stat(file).catch(() => undefined)
  if (!existing) {
    // Write to a unique temp file and rename: a crash must not leave a
    // truncated artifact under a digest that says it is complete, and two
    // concurrent puts of the same bytes must not collide on the temp name.
    // A rename that loses the race is success when the destination exists.
    // (SEC-04 / RISK-PERSIST-05)
    const tmp = path.join(dir, `.${sha256}.${ext}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
    await writeFile(tmp, bytes)
    await rename(tmp, file).catch(async (error: NodeJS.ErrnoException) => {
      if (await stat(file).catch(() => undefined)) return
      throw error
    })
  }

  return record(workspace, slug, sha256, ext, bytes.length, meta)
}
