import path from "path"

/**
 * Operation slugs are directory names directly under `.axiomsec/operation/`.
 *
 * A slug that could escape that directory — a path separator, a parent
 * reference, an absolute path — must never reach a path primitive, otherwise a
 * model-supplied slug can redirect a write outside the operation tree.
 * (SEC-01 / RISK-SCOPE-07)
 *
 * The pattern intentionally allows only characters that `safeSlug` produces,
 * plus the legacy `.`/`_`/`-` characters, so existing installs keep working.
 */
export const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG_PATTERN.test(slug)
}

/**
 * Resolve `slug` under `root` and refuse anything that escapes it.
 * Throws instead of returning a fallback path: a containment failure must be
 * visible, never silently redirected. (ENG-07)
 */
export function containedPath(root: string, slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`Invalid operation slug: ${JSON.stringify(slug)}`)
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, slug)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Invalid operation slug: ${JSON.stringify(slug)}`)
  }
  return resolved
}
