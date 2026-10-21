import { Flock } from "@axiomsec/shared/util/flock"

export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Module-level callers (scripts, tests) may not have initialized the global lock dir.
  if (!Flock.isConfigured()) return fn()
  return Flock.withLock(key, fn, { timeoutMs: 30_000 })
}
