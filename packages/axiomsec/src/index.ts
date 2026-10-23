import { InstallationVersion } from "./installer/version"

const args = process.argv.slice(2)

// Fast path: version inspection must not pay for the full CLI graph.
if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  process.stdout.write(InstallationVersion + "\n")
  process.exit(0)
}

try {
  await import("./main")
} catch (error) {
  process.stderr.write((error instanceof Error ? (error.stack ?? error.message) : String(error)) + "\n")
  process.exit(1)
}
