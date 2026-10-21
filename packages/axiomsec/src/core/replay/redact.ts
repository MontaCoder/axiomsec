const HEADER_KEYS = new Set(["authorization", "proxyauthorization", "cookie", "setcookie", "xapikey"])
const SECRET_KEYS = new Set([
  "password",
  "passwd",
  "pass",
  "apikey",
  "token",
  "secret",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "privatekey",
])
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
const AUTH_HEADER_RE = /^(\s*(?:proxy-)?authorization\s*:\s*).*$/gim
const COOKIE_HEADER_RE = /^(\s*(?:set-)?cookie\s*:\s*).*$/gim
const QUOTED_SECRET_RE =
  /(["'](?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|token|secret)["']\s*:\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gi
const SECRET_ASSIGN_RE =
  /\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|token|secret)\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;"'\r\n]+)/gi

export type RedactMode = "off" | "on"

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function isSensitiveKey(key: string) {
  const normalized = normalizeKey(key)
  return HEADER_KEYS.has(normalized) || SECRET_KEYS.has(normalized)
}

function redactedValueForKey(key: string) {
  return HEADER_KEYS.has(normalizeKey(key)) ? `[redacted:header:${key}]` : `[redacted:secret:${key}]`
}

export function redactString(value: string, mode: RedactMode): string {
  if (mode === "off") return value
  return value
    .replace(JWT_RE, "[redacted:jwt]")
    .replace(AUTH_HEADER_RE, "$1[redacted:header:authorization]")
    .replace(COOKIE_HEADER_RE, "$1[redacted:header:cookie]")
    .replace(QUOTED_SECRET_RE, '$1"[redacted:secret]"')
    .replace(SECRET_ASSIGN_RE, "$1[redacted:secret]")
}

export function redactValue(value: unknown, mode: RedactMode, keyHint?: string): unknown {
  if (mode === "off") return value
  if (value === null || value === undefined) return value
  if (typeof value === "string") {
    if (keyHint && isSensitiveKey(keyHint)) return redactedValueForKey(keyHint)
    return redactString(value, mode)
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, mode, keyHint))
  if (typeof value === "object") {
    const pairName =
      "name" in value && typeof value.name === "string"
        ? value.name
        : "key" in value && typeof value.key === "string"
          ? value.key
          : undefined
    if (pairName && isSensitiveKey(pairName)) {
      const redacted = redactedValueForKey(pairName)
      const copy: Record<string, unknown> = Object.fromEntries(Object.entries(value))
      if (typeof copy.value === "string") copy.value = redacted
      else if (Array.isArray(copy.value)) copy.value = copy.value.map((item) => (typeof item === "string" ? redacted : item))
      return copy
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v, mode, k)
    }
    return out
  }
  return value
}
