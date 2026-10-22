import { Boundary, type Decision, type Request } from "./schema"

function globToRegex(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp("^" + esc + "$", "i")
}

function effectivePort(url: URL): string {
  if (url.port) return url.port
  switch (url.protocol) {
    case "https:":
    case "wss:":
      return "443"
    case "http:":
    case "ws:":
      return "80"
    default:
      return ""
  }
}

function matchSchemePattern(pattern: string, u: URL): boolean {
  let p: URL
  try {
    p = new URL(pattern)
  } catch {
    return false
  }
  if (u.protocol !== p.protocol) return false
  if (p.hostname.startsWith("*.")) {
    if (!u.hostname.endsWith(p.hostname.slice(1))) return false
  } else if (u.hostname !== p.hostname) {
    return false
  }
  if (effectivePort(u) !== effectivePort(p)) return false
  const path = p.pathname || "/"
  if (path === "/") return true
  const target = u.pathname || "/"
  if (path.includes("*") || path.includes("?")) return globToRegex(path).test(target)
  return target === path || target.startsWith(path.endsWith("/") ? path : path + "/")
}

function matches(pattern: string, req: Request): boolean {
  if (!pattern) return false
  if (req.kind === "url") {
    try {
      const u = new URL(req.value)
      if (pattern.includes("://")) return matchSchemePattern(pattern, u)
      // Hostnames are case-insensitive. The URL parser lowercases the request
      // host, so the pattern must be normalized the same way or an operator
      // entry such as "Example.COM" would silently never match. (SEC-01)
      const host = u.hostname.toLowerCase()
      if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1).toLowerCase())
      if (pattern.includes("/")) return req.value.toLowerCase().startsWith(pattern.toLowerCase())
      return host === pattern.toLowerCase()
    } catch {
      return false
    }
  }
  if (req.kind === "host") {
    const host = req.value.toLowerCase()
    if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1).toLowerCase())
    return host === pattern.toLowerCase()
  }
  if (req.kind === "path" || req.kind === "raw") {
    if (pattern.includes("*") || pattern.includes("?")) return globToRegex(pattern).test(req.value)
    return req.value === pattern || req.value.startsWith(pattern.endsWith("/") ? pattern : pattern + "/")
  }
  return false
}

export function evaluate(boundary: unknown, req: Request): Decision {
  const parsed = Boundary.safeParse(boundary ?? {})
  const b = parsed.success
    ? parsed.data
    : { default: "ask" as const, in_scope: [], out_of_scope: [] }

  for (const p of b.out_of_scope) {
    if (matches(p, req)) return { mode: "deny", reason: "matched out_of_scope", matched: p }
  }
  for (const p of b.in_scope) {
    if (matches(p, req)) return { mode: "allow", reason: "matched in_scope", matched: p }
  }
  if (b.in_scope.length === 0 && b.out_of_scope.length === 0) {
    return { mode: b.default, reason: "no boundary defined" }
  }
  return { mode: b.default, reason: "no pattern matched" }
}
