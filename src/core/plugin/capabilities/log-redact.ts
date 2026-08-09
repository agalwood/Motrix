// Privacy redaction at the capability log boundary (spec §7 L2391-2403).
//
// Pure transform: input is the structured fields a plugin passed to
// log.{level}(msg, fields); output is the same shape with known-sensitive
// keys removed or scrubbed. The plugin's `msg` (free-text) is NOT inspected
// — redaction is scoped to the structured surface. Plugins are documented to
// avoid embedding raw secrets in free-text log messages.
//
// Rules applied in non-verbose mode:
//   url           → URL.origin + URL.pathname (strip query + fragment)
//   headers       → dropped
//   body          → dropped
//   path          → basename()
//   filePath      → basename()
//   storageKey    → truncate to 32 chars + ellipsis when longer
//   storageValue  → dropped
//
// In verbose mode (per-plugin toggle, spec §7 L2403), all fields pass through
// unchanged — the host UI shows a red banner while verbose is active and
// resets after a 1-hour TTL or session end.

import { basename } from 'node:path'

const STORAGE_KEY_MAX_CHARS = 32

function redactUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '[unparseable-url]'
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname}`
  } catch {
    return '[unparseable-url]'
  }
}

function redactPath(raw: unknown): string {
  if (typeof raw !== 'string') return '[unparseable-path]'
  return basename(raw)
}

function redactStorageKey(raw: unknown): string | unknown {
  if (typeof raw !== 'string') return raw
  if (raw.length <= STORAGE_KEY_MAX_CHARS) return raw
  return `${raw.slice(0, STORAGE_KEY_MAX_CHARS)}…`
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function redactValue(value: unknown, key: string): unknown {
  switch (key) {
    case 'url':
      return redactUrl(value)
    case 'path':
    case 'filePath':
      return redactPath(value)
    case 'storageKey':
      return redactStorageKey(value)
    default:
      return value
  }
}

// Keys whose value is dropped entirely (regardless of depth).
const DROP_KEYS = new Set(['headers', 'body', 'storageValue'])

/**
 * Redacts known-sensitive fields in a plugin-supplied structured-log payload.
 * Returns a NEW object — the input is never mutated. Recurses one level into
 * plain objects so nested `request.headers`, `request.url`, etc. are caught.
 *
 * @param fields  The plugin's fields argument.
 * @param verbose When true, the original object is returned unchanged.
 */
export function redactFields(
  fields: Record<string, unknown>,
  verbose = false
): Record<string, unknown> {
  if (verbose) return fields

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (DROP_KEYS.has(k)) continue
    if (isPlainObject(v)) {
      out[k] = redactFields(v, false)
      continue
    }
    out[k] = redactValue(v, k)
  }
  return out
}
