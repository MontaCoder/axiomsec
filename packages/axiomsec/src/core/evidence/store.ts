import { appendFile, mkdir, readFile, writeFile, stat, rename } from "fs/promises"
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
async function readManifest(workspace: string, slug: string): Promise<Manifest> {
  const p = path.join(evidenceDir(workspace, slug), MANIFEST)
  const raw = await readFile(p, "utf8").catch(() => "")
  if (!raw) return { entries: [], malformed: 0 }
  const entries: Entry[] = []
  let malformed = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      entries.push(Entry.parse(JSON.parse(line)))
    } catch {
      malformed += 1
    }
  }
  if (malformed > 0) {
    log.warn("evidence manifest has malformed lines", { slug, malformed, manifest: p })
  }
  return { entries, malformed }
}

function lockKey(workspace: string, slug: string) {
  return `evidence:${path.resolve(evidenceDir(workspace, slug))}`
}

export async function list(workspace: string, slug: string): Promise<Entry[]> {
  return withFileLock(lockKey(workspace, slug), async () => (await readManifest(workspace, slug)).entries)
}

export async function get(workspace: string, slug: string, sha256: string): Promise<{ entry: Entry; bytes: Uint8Array } | undefined> {
  return withFileLock(lockKey(workspace, slug), async () => {
    const { entries } = await readManifest(workspace, slug)
    const entry = entries.find((e) => e.sha256 === sha256)
    if (!entry) return undefined
    const p = path.join(evidenceDir(workspace, slug), `${entry.sha256}.${entry.ext}`)
    const bytes = await readFile(p).catch(() => undefined)
    if (!bytes) return undefined
    return { entry, bytes: new Uint8Array(bytes) }
  })
}

export async function verify(workspace: string, slug: string, sha256: string): Promise<boolean> {
  const found = await get(workspace, slug, sha256)
  if (!found) return false
  const digest = createHash("sha256").update(found.bytes).digest("hex")
  return digest === sha256
}

export async function put(
  workspace: string,
  slug: string,
  input: Uint8Array | string | { path: string },
  meta: { mime?: string; label?: string; source?: string; ext?: string } = {},
): Promise<Entry> {
  const bytes =
    input instanceof Uint8Array
      ? Buffer.from(input)
      : typeof input === "string"
        ? Buffer.from(input, "utf8")
        : await readFile(input.path)

  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const ext = (meta.ext ?? sniffExtFromMime(meta.mime)).replace(/^\./, "")
  const dir = evidenceDir(workspace, slug)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${sha256}.${ext}`)

  const existing = await stat(file).catch(() => undefined)
  if (!existing) {
    // Write to a temp file and rename: a crash must not leave a truncated
    // artifact under a digest that says it is complete. (SEC-04 / RISK-PERSIST-05)
    const tmp = path.join(dir, `.${sha256}.${ext}.tmp`)
    await writeFile(tmp, bytes)
    await rename(tmp, file)
  }

  return withFileLock(lockKey(workspace, slug), async () => {
    const { entries: current } = await readManifest(workspace, slug)
    const existing = current.find((e) => e.sha256 === sha256)
    if (existing) return existing
    const entry: Entry = {
      sha256,
      ext,
      size: bytes.length,
      mime: meta.mime,
      label: meta.label,
      source: meta.source,
      at: Date.now(),
    }
    await appendFile(path.join(dir, MANIFEST), JSON.stringify(entry) + "\n", "utf8")
    return entry
  })
}
