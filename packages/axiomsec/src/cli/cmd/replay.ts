import type { Argv } from "yargs"
import * as fs from "node:fs/promises"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Session } from "../../session"
import { SessionID } from "../../session/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { buildReplay, parseReplay, verifyBody } from "@/core/replay/format"
import { which } from "../../support/which"

export const ReplayCommand = cmd({
  command: "replay <command>",
  describe: "save and replay axiomsec engagements (.axiomsec files)",
  builder: (yargs: Argv) =>
    yargs.command(ReplaySaveCommand).command(ReplayShowCommand).command(ReplayVerifyCommand).demandCommand(),
  async handler() {},
})

export const ReplaySaveCommand = cmd({
  command: "save <sessionID>",
  describe: "export a session as a .axiomsec replay file",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", { type: "string", demandOption: true, describe: "session id to export" })
      .option("out", { type: "string", describe: "output file path (default stdout)" })
      .option("redact", { type: "boolean", default: false, describe: "redact secrets/tokens/headers" })
      .option("sign", { type: "boolean", default: false, describe: "sign trailer with minisign/cosign if available" }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessionID = SessionID.make(args.sessionID)
      const info = await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(sessionID)))
      const messages = await AppRuntime.runPromise(Session.Service.use((svc) => svc.messages({ sessionID: info.id })))
      const built = buildReplay({ info, messages, redact: args.redact ? "on" : "off" })
      let output = built.lines.join("\n") + "\n"

      if (args.sign) {
        const sig = sign(built.trailer.sha256_body)
        if (sig) {
          const trailerWithSig = { ...built.trailer, signed: true, signature: sig }
          const lines = built.lines.slice(0, -1)
          lines.push(JSON.stringify(trailerWithSig))
          output = lines.join("\n") + "\n"
        } else {
          process.stderr.write("warning: no signing tool found (minisign/cosign); emitting unsigned\n")
        }
      }

      if (args.out) {
        await fs.writeFile(args.out, output, "utf-8")
        UI.println(`Wrote ${args.out} (${built.trailer.events} events, sha256=${built.trailer.sha256_body.slice(0, 12)}…)`)
      } else {
        process.stdout.write(output)
      }
    })
  },
})

export const ReplayShowCommand = cmd({
  command: "show <file>",
  describe: "render a .axiomsec replay file as a transcript (no tool execution)",
  builder: (yargs: Argv) =>
    yargs.positional("file", { type: "string", demandOption: true, describe: "path to .axiomsec file" }),
  handler: async (args) => {
    const text = await fs.readFile(args.file, "utf-8")
    const { header, events, trailer } = parseReplay(text)
    const verify = verifyBody(text)
    UI.println(`◢◤ axiomsec replay — ${header.id}`)
    UI.println(`format=${header.format} kind=${header.kind ?? "-"} model=${header.model?.id ?? "-"}`)
    UI.println(
      `events=${trailer.events} duration=${(trailer.duration_ms / 1000).toFixed(1)}s sha256=${trailer.sha256_body.slice(0, 12)}…`,
    )
    UI.println(verify.ok ? "integrity: ok" : `integrity: MISMATCH (expected ${verify.expected.slice(0, 12)}…, got ${verify.actual.slice(0, 12)}…)`)
    if (trailer.signed && trailer.signature) {
      const result = verifySignature(trailer.sha256_body, trailer.signature)
      UI.println(`signature: ${trailer.signature.scheme} ${result.ok ? "verified" : `UNVERIFIED — ${result.detail}`}`)
    } else {
      UI.println("signature: none")
    }
    UI.empty()
    for (const e of events) {
      const ts = e.ts.replace("T", " ").replace(/\..*Z$/, "")
      if (e.event === "message") {
        const role = (e.data.role as string).toUpperCase()
        UI.println(`[${ts}] ${role}: ${truncate(String(e.data.text ?? ""), 2000)}`)
      } else if (e.event === "tool_call") {
        UI.println(`[${ts}] TOOL ${e.data.tool} ← ${truncate(JSON.stringify(e.data.input ?? {}), 400)}`)
      } else if (e.event === "tool_result") {
        const status = e.data.status as string
        UI.println(`[${ts}] TOOL ${status} (${e.data.duration_ms}ms) → ${truncate(JSON.stringify(e.data.output ?? e.data.error ?? ""), 400)}`)
      } else {
        UI.println(`[${ts}] ${e.event} ${truncate(JSON.stringify(e.data), 400)}`)
      }
    }
  },
})

export const ReplayVerifyCommand = cmd({
  command: "verify <file>",
  describe: "verify integrity (sha256 + signature if present) of a .axiomsec file",
  builder: (yargs: Argv) =>
    yargs.positional("file", { type: "string", demandOption: true, describe: "path to .axiomsec file" }),
  handler: async (args) => {
    const text = await fs.readFile(args.file, "utf-8")
    const { trailer } = parseReplay(text)
    const verify = verifyBody(text)
    if (!verify.ok) {
      UI.error(`sha256 mismatch: expected ${verify.expected}, got ${verify.actual}`)
      process.exit(1)
    }
    UI.println(`sha256: ok (${verify.actual.slice(0, 16)}…)`)
    if (trailer.signed && trailer.signature) {
      const result = verifySignature(trailer.sha256_body, trailer.signature)
      if (result.ok) {
        UI.println(`signature: ${trailer.signature.scheme} verified`)
      } else {
        UI.error(`signature: ${trailer.signature.scheme} UNVERIFIED — ${result.detail}`)
        process.exitCode = 1
      }
    } else {
      UI.println("signature: none")
    }
  },
})

function verifySignature(
  payload: string,
  signature: { scheme: string; value: string; public_key_id?: string },
): { ok: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), "axiomsec-verify-"))
  try {
    const payloadPath = join(dir, "payload.txt")
    writeFileSync(payloadPath, payload)
    if (signature.scheme === "minisign") {
      const publicKey = process.env.AXIOMSEC_MINISIGN_PUBKEY
      if (!publicKey) return { ok: false, detail: "set AXIOMSEC_MINISIGN_PUBKEY to the public key file" }
      if (!which("minisign")) return { ok: false, detail: "minisign is not on PATH" }
      const sigPath = join(dir, "signature.minisig")
      writeFileSync(sigPath, Buffer.from(signature.value, "base64"))
      const result = spawnSync("minisign", ["-Vm", payloadPath, "-x", sigPath, "-p", publicKey], {
        encoding: "utf-8",
        timeout: 10_000,
      })
      if (result.status === 0) return { ok: true, detail: "minisign signature verified" }
      return { ok: false, detail: (result.stderr || result.stdout || "minisign verification failed").trim() }
    }
    if (signature.scheme === "cosign") {
      const publicKey = process.env.COSIGN_PUBKEY
      if (!publicKey) return { ok: false, detail: "set COSIGN_PUBKEY to the public key file" }
      if (!which("cosign")) return { ok: false, detail: "cosign is not on PATH" }
      const sigPath = join(dir, "signature.txt")
      writeFileSync(sigPath, signature.value)
      const result = spawnSync(
        "cosign",
        ["verify-blob", "--key", publicKey, "--signature", sigPath, "--insecure-ignore-tlog=true", payloadPath],
        { encoding: "utf-8", timeout: 10_000 },
      )
      if (result.status === 0) return { ok: true, detail: "cosign signature verified" }
      return { ok: false, detail: (result.stderr || result.stdout || "cosign verification failed").trim() }
    }
    return { ok: false, detail: `unknown signature scheme ${signature.scheme}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function truncate(s: string, max: number) {
  if (s.length <= max) return s
  return s.slice(0, max) + `…[+${s.length - max} chars]`
}

function sign(payload: string): { scheme: string; value: string; public_key_id?: string } | null {
  if (which("minisign")) {
    const tmpIn = join(tmpdir(), `axiomsec-sign-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
    const tmpSig = `${tmpIn}.minisig`
    try {
      writeFileSync(tmpIn, payload)
      const r = spawnSync("minisign", ["-Sm", tmpIn], { encoding: "utf-8", timeout: 10_000 })
      if (r.status === 0) {
        const sigText = readFileSync(tmpSig, "utf-8")
        return { scheme: "minisign", value: Buffer.from(sigText).toString("base64") }
      }
    } catch {
      /* fallthrough */
    } finally {
      rmSync(tmpIn, { force: true })
      rmSync(tmpSig, { force: true })
    }
  }
  if (which("cosign")) {
    const r = spawnSync("cosign", ["sign-blob", "--yes", "-"], {
      input: payload,
      encoding: "utf-8",
      timeout: 10_000,
    })
    if (r.status === 0 && r.stdout) {
      return { scheme: "cosign", value: r.stdout.trim() }
    }
  }
  return null
}
