#!/usr/bin/env bun

/**
 * Repeatable performance baseline for the axiomsec binary.
 *
 *   bun script/bench.ts --label baseline --out docs/performance/baseline.json
 *   bun script/bench.ts compare docs/performance/baseline.json docs/performance/latest.json
 *
 * Every number is local-machine relative; use the same host and an idle
 * machine when comparing runs.
 */

import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"
import { spawn as spawnPty } from "bun-pty"

const root = path.resolve(import.meta.dir, "..")
const isWin = process.platform === "win32"
const exe = isWin ? "axiomsec.exe" : "axiomsec"

function resolveBinary() {
  if (process.env.AXIOMSEC_BIN) return path.resolve(process.env.AXIOMSEC_BIN)
  const dist = path.join(root, "packages/axiomsec/dist")
  if (!fs.existsSync(dist)) throw new Error(`no build found at ${dist}; run the build first`)
  const dir = fs
    .readdirSync(dist)
    .filter((name) => name.startsWith("axiomsec-"))
    .map((name) => path.join(dist, name, "bin", exe))
    .find((file) => fs.existsSync(file))
  if (!dir) throw new Error(`no axiomsec binary under ${dist}`)
  return dir
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  const sum = sorted.reduce((acc, value) => acc + value, 0)
  return {
    min: round(sorted[0]),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
    samples: values.length,
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function isoHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axiomsec-bench-"))
  return {
    dir,
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      AXIOMSEC_DISABLE_SHARE: "1",
      AXIOMSEC_DISABLE_TELEMETRY: "1",
      TERM: "xterm-256color",
      CI: "1",
    } as Record<string, string>,
  }
}

function coldStart(bin: string, runs: number) {
  const env = isoHome().env
  for (let i = 0; i < 2; i++) {
    Bun.spawnSync({ cmd: [bin, "--version"], env, stdout: "ignore", stderr: "ignore" })
  }
  const version: number[] = []
  const help: number[] = []
  for (let i = 0; i < runs; i++) {
    let start = performance.now()
    const v = Bun.spawnSync({ cmd: [bin, "--version"], env, stdout: "ignore", stderr: "ignore" })
    version.push(performance.now() - start)
    if (v.exitCode !== 0) throw new Error("--version failed")
    start = performance.now()
    const h = Bun.spawnSync({ cmd: [bin, "--help"], env, stdout: "ignore", stderr: "ignore" })
    help.push(performance.now() - start)
    if (h.exitCode !== 0) throw new Error("--help failed")
  }
  return { versionMs: stats(version), helpMs: stats(help) }
}

async function processMetrics(pid: number) {
  if (isWin) {
    const out = await $`powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64; (Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds"`
      .quiet()
      .text()
    const [rss, cpu] = out.trim().split(/\r?\n/).map(Number)
    return { rssBytes: rss, cpuSeconds: cpu }
  }
  if (process.platform === "linux") {
    const status = await Bun.file(`/proc/${pid}/status`).text()
    const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024
    const stat = await Bun.file(`/proc/${pid}/stat`).text()
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const ticks = Number(fields[11]) + Number(fields[12])
    const cpuSeconds = ticks / 100
    return { rssBytes: rss, cpuSeconds }
  }
  const rss = Number((await $`ps -o rss= -p ${pid}`.quiet().text()).trim()) * 1024
  const time = (await $`ps -o time= -p ${pid}`.quiet().text()).trim()
  const parts = time.split(":").map(Number)
  const cpuSeconds = parts.reduce((acc, part) => acc * 60 + part, 0)
  return { rssBytes: rss, cpuSeconds }
}

async function startServer(bin: string) {
  const home = isoHome()
  const started = performance.now()
  const proc = Bun.spawn({
    cmd: [bin, "serve", "--port", "0"],
    cwd: home.dir,
    env: home.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const decoder = new TextDecoder()
  let url: string | undefined
  let stderr = ""
  const deadline = Date.now() + 30_000
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      const match = /listening on (http:\/\/[^\s]+)/.exec(text)
      if (!match) continue
      url = match[1]
      break
    }
  }
  const errRead = (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) stderr += decoder.decode(chunk)
  })()
  await Promise.race([
    read(proc.stdout as ReadableStream<Uint8Array>),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not listen: ${stderr}`)), 30_000)),
  ])
  if (!url) throw new Error(`server did not print a URL: ${stderr}`)
  const startupMs = performance.now() - started
  return { proc, url, startupMs, cleanup: () => proc.kill() }
}

async function load(serverUrl: string) {
  const url = new URL("/path", serverUrl)
  for (let i = 0; i < 20; i++) {
    const response = await fetch(url)
    await response.arrayBuffer()
    if (!response.ok) throw new Error(`warmup ${response.status}`)
  }
  const samples: { rss: number; cpu: number }[] = []
  const sampler = setInterval(async () => {
    try {
      samples.push(await processMetrics(serverPid!))
    } catch {}
  }, 250)

  let requests = 0
  const errors: string[] = []
  const workers = 16
  const durationMs = 4000
  const stopAt = performance.now() + durationMs
  const worker = async () => {
    while (performance.now() < stopAt) {
      try {
        const response = await fetch(url)
        await response.arrayBuffer()
        if (!response.ok) errors.push(String(response.status))
        requests++
      } catch (error) {
        errors.push(String(error))
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, worker))
  clearInterval(sampler)
  const peakRss = samples.length ? Math.max(...samples.map((s) => s.rss)) : 0
  const cpu = samples.length ? samples[samples.length - 1].cpu - samples[0].cpu : 0
  return {
    requestsPerSecond: round(requests / (durationMs / 1000)),
    errors: errors.length,
    peakRssMb: round(peakRss / 1024 / 1024),
    idleCpuPercent: round((cpu / (durationMs / 1000)) * 100),
    serverPid: serverPid!,
  }
}

let serverPid: number | undefined

async function serverBench(bin: string) {
  const server = await startServer(bin)
  serverPid = server.proc.pid
  try {
    await Bun.sleep(2000)
    const before = await processMetrics(server.proc.pid)
    await Bun.sleep(3000)
    const idle = await processMetrics(server.proc.pid)
    const result = await load(server.url)
    return {
      startupMs: round(server.startupMs),
      rssAfter3sMb: round(idle.rssBytes / 1024 / 1024),
      idleCpuPercent3s: round(((idle.cpuSeconds - before.cpuSeconds) / 3) * 100),
      ...result,
      url: server.url,
    }
  } finally {
    server.cleanup()
  }
}

async function tuiProbe(bin: string) {
  const home = isoHome()
  const terminal = spawnPty(bin, [], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: home.dir,
    env: home.env,
  })
  const started = performance.now()
  let firstData = 0
  let firstFrame = 0
  let lastData = 0
  let bytes = 0
  let pending: ((value: number) => void) | undefined
  const rss: number[] = []
  const sampler = setInterval(async () => {
    try {
      rss.push((await processMetrics(terminal.pid)).rssBytes)
    } catch {}
  }, 250)
  terminal.onData((data) => {
    bytes += data.length
    const now = performance.now()
    if (!firstData && data.length > 0) firstData = now - started
    if (!firstFrame && data.includes("\x1b[")) firstFrame = now - started
    lastData = now
    const resolve = pending
    pending = undefined
    resolve?.(now)
  })
  const waitForData = (timeoutMs: number) =>
    new Promise<number>((resolve) => {
      pending = resolve
      setTimeout(() => resolve(0), timeoutMs)
    })
  try {
    await waitForData(20_000)
    if (!firstFrame) throw new Error("TUI did not render a frame")
    // Let startup output and first-run work settle before timing input.
    await Bun.sleep(4000)
    const beforeInput = performance.now()
    const next = waitForData(5_000)
    terminal.write(process.env.BENCH_TUI_KEY ?? "/")
    const latency = await next
    const inputLatencyMs = latency ? latency - beforeInput : 0
    const peakRss = rss.length ? Math.max(...rss) : 0
    return {
      firstDataMs: round(firstData),
      firstFrameMs: round(firstFrame),
      inputToNextFrameMs: round(inputLatencyMs),
      outputBytes: bytes,
      peakRssMb: round(peakRss / 1024 / 1024),
    }
  } finally {
    clearInterval(sampler)
    try {
      terminal.write("\x03")
      await Bun.sleep(300)
    } catch {}
    try {
      terminal.kill()
    } catch {}
  }
}

async function artifacts(bin: string) {
  const binaryBytes = fs.statSync(bin).size
  const dist = path.join(root, "packages/axiomsec/dist")
  const distBytes = fs.existsSync(dist)
    ? Number((await $`du -sk ${dist}`.quiet().text()).trim().split(/\s+/)[0]) * 1024
    : 0
  const lockfile = fs.readFileSync(path.join(root, "bun.lock"), "utf8")
  const installed = fs.existsSync(path.join(root, "node_modules"))
    ? Number((await $`du -sk ${path.join(root, "node_modules")}`.quiet().text()).trim().split(/\s+/)[0]) * 1024
    : 0
  const hash = new Bun.CryptoHasher("sha256").update(fs.readFileSync(bin)).digest("hex")
  return {
    binaryMb: round(binaryBytes / 1024 / 1024),
    distMb: round(distBytes / 1024 / 1024),
    installedMb: round(installed / 1024 / 1024),
    lockfileLines: lockfile.split("\n").length,
    binarySha256: hash,
  }
}

async function run(label: string, out?: string) {
  const bin = resolveBinary()
  console.log(`# bench ${label}`)
  console.log(`binary ${bin}`)
  const cold = coldStart(bin, 15)
  console.log(`cold start --version median ${cold.versionMs.median}ms, --help median ${cold.helpMs.median}ms`)
  const server = await serverBench(bin)
  console.log(
    `server up ${server.startupMs}ms, RSS ${server.rssAfter3sMb}MB, idle CPU ${server.idleCpuPercent3s}%, ${server.requestsPerSecond} req/s`,
  )
  const tuiSamples = [await tuiProbe(bin), await tuiProbe(bin), await tuiProbe(bin)]
  const median = (values: number[]) => stats(values).median
  const tui = {
    firstDataMs: median(tuiSamples.map((sample) => sample.firstDataMs)),
    firstFrameMs: median(tuiSamples.map((sample) => sample.firstFrameMs)),
    inputToNextFrameMs: median(tuiSamples.map((sample) => sample.inputToNextFrameMs)),
    outputBytes: tuiSamples[0].outputBytes,
    peakRssMb: median(tuiSamples.map((sample) => sample.peakRssMb)),
    samples: tuiSamples,
  }
  console.log(
    `tui first frame ${tui.firstFrameMs}ms, input->frame ${tui.inputToNextFrameMs}ms (median of 3), RSS ${tui.peakRssMb}MB`,
  )
  const sizes = await artifacts(bin)
  console.log(`binary ${sizes.binaryMb}MB, dist ${sizes.distMb}MB, install ${sizes.installedMb}MB, lock ${sizes.lockfileLines} lines`)
  const result = {
    label,
    date: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    node: process.version,
    binary: path.relative(root, bin),
    coldStart: cold,
    server: { ...server, url: undefined },
    tui,
    sizes,
  }
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
    fs.writeFileSync(path.resolve(out), JSON.stringify(result, null, 2) + "\n")
    console.log(`wrote ${out}`)
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
}

async function compare(beforePath: string, afterPath: string) {
  const before = JSON.parse(fs.readFileSync(beforePath, "utf8"))
  const after = JSON.parse(fs.readFileSync(afterPath, "utf8"))
  const rows: string[][] = []
  const add = (name: string, a: number, b: number, unit: string, lowerIsBetter = true) => {
    const delta = a === 0 ? 0 : ((b - a) / a) * 100
    const better = lowerIsBetter ? delta < 0 : delta > 0
    rows.push([
      name,
      `${round(a)}${unit}`,
      `${round(b)}${unit}`,
      `${delta >= 0 ? "+" : ""}${round(delta)}%${better ? " ✓" : delta === 0 ? "" : " ✗"}`,
    ])
  }
  add("cold start --version p50", before.coldStart.versionMs.median, after.coldStart.versionMs.median, "ms")
  add("cold start --help p50", before.coldStart.helpMs.median, after.coldStart.helpMs.median, "ms")
  add("server startup", before.server.startupMs, after.server.startupMs, "ms")
  add("server RSS", before.server.rssAfter3sMb, after.server.rssAfter3sMb, "MB")
  add("server idle CPU", before.server.idleCpuPercent3s, after.server.idleCpuPercent3s, "%")
  add("HTTP throughput", before.server.requestsPerSecond, after.server.requestsPerSecond, " req/s", false)
  add("TUI first frame", before.tui.firstFrameMs, after.tui.firstFrameMs, "ms")
  add("TUI input latency", before.tui.inputToNextFrameMs, after.tui.inputToNextFrameMs, "ms")
  add("TUI peak RSS", before.tui.peakRssMb, after.tui.peakRssMb, "MB")
  add("binary size", before.sizes.binaryMb, after.sizes.binaryMb, "MB")
  add("dist size", before.sizes.distMb, after.sizes.distMb, "MB")
  add("installed size", before.sizes.installedMb, after.sizes.installedMb, "MB")
  add("lockfile lines", before.sizes.lockfileLines, after.sizes.lockfileLines, "")
  console.log(`| Metric | ${before.label} | ${after.label} | Delta |`)
  console.log(`|---|---:|---:|---:|`)
  for (const row of rows) console.log(`| ${row.join(" | ")} |`)
}

const argv = process.argv.slice(2)
if (argv[0] === "compare") {
  if (argv.length < 3) throw new Error("usage: bench.ts compare <before.json> <after.json>")
  await compare(argv[1], argv[2])
} else if (argv[0] === "tui") {
  const bin = resolveBinary()
  const samples = [await tuiProbe(bin), await tuiProbe(bin), await tuiProbe(bin)]
  console.log(JSON.stringify(samples, null, 2))
} else {
  const labelIndex = argv.indexOf("--label")
  const outIndex = argv.indexOf("--out")
  const label = labelIndex >= 0 ? argv[labelIndex + 1] : "run"
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined
  await run(label, out)
}
process.exit(0)
