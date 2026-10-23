#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await import("./generate.ts")

import { Script } from "@axiomsec/script"
import pkg from "../package.json"

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const plugin = createSolidTransformPlugin()
const linker = process.platform === "win32" ? ["--linker", "hoisted"] : []
const buildOs = process.env.AXIOMSEC_BUILD_OS?.split(",").map((item) => item.trim()).filter(Boolean)

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = allTargets.filter((item) => {
  if (buildOs && buildOs.length > 0 && !buildOs.includes(item.os)) {
    return false
  }

  if (!singleFlag) {
    return true
  }

  if (item.os !== process.platform || item.arch !== process.arch) {
    return false
  }

  // When building for the current platform, prefer a single native binary by default.
  // Baseline binaries require additional Bun artifacts and can be flaky to download.
  if (item.avx2 === false) {
    return baselineFlag
  }

  // also skip abi-specific builds for the same reason
  if (item.abi !== undefined) {
    return false
  }

  return true
})

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall && !singleFlag) {
  // Release builds may target another OS/libc and need every native variant.
  await $`bun install ${linker} --os="*" --cpu="*" --libc="*" --no-save @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install ${linker} --os="*" --cpu="*" --libc="*" --no-save @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/cmd/tui/worker.ts"
  const rgPath = "./src/files/ripgrep.worker.ts"

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  // OpenTUI statically imports every platform binary; keep only the target's
  // native package so cross-builds do not require unrelated libc/OS variants.
  const nativePackage = `@opentui/core-${item.os}-${item.arch}${item.abi === "musl" ? "-musl" : ""}`
  const openTuiPackages = [
    "@opentui/core-darwin-x64",
    "@opentui/core-darwin-arm64",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-arm64",
    "@opentui/core-linux-x64-musl",
    "@opentui/core-linux-arm64-musl",
    "@opentui/core-win32-x64",
    "@opentui/core-win32-arm64",
  ]

  await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: [
      "node-gyp",
      "electron",
      "chromium-bidi",
      "chromium-bidi/*",
      ...openTuiPackages.filter((entry) => entry !== nativePackage),
    ],
    format: "esm",
    minify: true,
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/axiomsec`,
      execArgv: [`--user-agent=axiomsec/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    entrypoints: [
      "./src/index.ts",
      parserWorker,
      workerPath,
      rgPath,
    ],
    define: {
      AXIOMSEC_VERSION: `'${Script.version}'`,
      AXIOMSEC_MIGRATIONS: JSON.stringify(migrations),
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      AXIOMSEC_WORKER_PATH: workerPath,
      AXIOMSEC_RIPGREP_WORKER_PATH: rgPath,
      AXIOMSEC_CHANNEL: `'${Script.channel}'`,
      AXIOMSEC_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/axiomsec`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        description: `axiomsec standalone binary for ${item.os}/${item.arch}${item.abi ? `/${item.abi}` : ""}${item.avx2 === false ? " baseline" : ""}`,
        license: pkg.license,
        repository: {
          type: "git",
          url: "https://github.com/MontaCoder/axiomsec",
        },
        homepage: "https://github.com/MontaCoder/axiomsec",
        bugs: {
          url: "https://github.com/MontaCoder/axiomsec/issues",
        },
        keywords: ["cybersecurity", "appsec", "pentest", "security", "agent", "terminal"],
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

export { binaries }
