import {
  loadOperationConsoleSnapshot,
  type OperationConsoleSnapshot,
} from "./snapshot"

export type OperationConsoleLoadOptions = { sessionID?: string; slug?: string }

export type OperationConsoleLoader = {
  (directory: string | undefined, options?: OperationConsoleLoadOptions): Promise<OperationConsoleSnapshot | undefined>
  /** Drop cached results after an operation attach/detach. In-flight loads still coalesce. */
  clear(): void
}

type Fetcher = (directory: string, options: OperationConsoleLoadOptions) => Promise<OperationConsoleSnapshot | undefined>

const CACHE_TTL_MS = 150
const CACHE_MAX_ENTRIES = 32

/**
 * Coalesce snapshot loads for all operation views.
 *
 * Every visible operation view refreshes on idle and on a completed tool call.
 * Without coalescing, five views read and parse the same projections five
 * times for one event. The cache is short-lived and owned by the TUI app, not
 * a module-global project map.
 */
export function createOperationConsoleLoader(
  fetcher: Fetcher = loadOperationConsoleSnapshot,
  ttlMs = CACHE_TTL_MS,
): OperationConsoleLoader {
  const inflight = new Map<string, Promise<OperationConsoleSnapshot | undefined>>()
  const cached = new Map<string, { at: number; value: OperationConsoleSnapshot | undefined }>()
  const key = (directory: string, options: OperationConsoleLoadOptions) =>
    `${directory}\0${options.sessionID ?? ""}\0${options.slug ?? ""}`

  return Object.assign(
    async (directory: string | undefined, options: OperationConsoleLoadOptions = {}) => {
      if (!directory) return undefined
      const cacheKey = key(directory, options)
      const hit = cached.get(cacheKey)
      if (hit && Date.now() - hit.at < ttlMs) return hit.value

      const pending = inflight.get(cacheKey)
      if (pending) return pending

      const promise = fetcher(directory, options)
        .then((value) => {
          if (cached.size >= CACHE_MAX_ENTRIES) {
            const oldest = cached.keys().next().value
            if (oldest !== undefined) cached.delete(oldest)
          }
          cached.set(cacheKey, { at: Date.now(), value })
          return value
        })
        .catch(() => undefined)
        .finally(() => inflight.delete(cacheKey))
      inflight.set(cacheKey, promise)
      return promise
    },
    { clear: () => cached.clear() },
  ) satisfies OperationConsoleLoader
}
