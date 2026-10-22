export type AllowUrl = (url: string) => Promise<boolean> | boolean

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch with a boundary callback and manual redirect handling. Every hop,
 * including redirect targets, must be explicitly allowed; anything else is
 * skipped. Returns null when a hop is not allowed or the redirect limit is hit.
 */
export async function fetchGuarded(
  url: string,
  init: RequestInit,
  allow?: AllowUrl,
  maxRedirects = 5,
): Promise<Response | null> {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (allow) {
      try {
        if (!(await allow(current))) return null
      } catch {
        return null
      }
    }
    const response = await fetch(current, { ...init, redirect: "manual" })
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location")
      if (location) {
        await response.body?.cancel().catch(() => undefined)
        current = new URL(location, current).href
        continue
      }
    }
    return response
  }
  return null
}
