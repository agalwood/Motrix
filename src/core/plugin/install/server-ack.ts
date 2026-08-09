// Phase 1A server-runtime ack rules (I27): unsigned plugins must be
// explicitly acknowledged by the operator before they run on a server.
//
// An ack can come from three sources, evaluated in this order:
//   1. The plugin directory already contains `_install.json` — meaning the
//      operator (or a prior server boot) consented at some earlier time.
//   2. The normalized source URL matches an entry in
//      `MOTRIX_PLUGIN_ALLOWLIST` (scheme + host + path prefix).
//   3. The operator set `--allow-unsigned-plugins` (blanketBypass).
//
// If none of these hold, the server rejects the plugin with
// `plugin.lifecycle.unsigned_not_allowed`. Default is fail-closed.

import type { InstallRecord } from '@shared/types/plugin-install'

export interface ServerAckCtx {
  /** Patterns from `MOTRIX_PLUGIN_ALLOWLIST` (URLs with scheme + host + path) */
  allowlist: ReadonlyArray<string>
  /** Came from `--allow-unsigned-plugins` */
  blanketBypass: boolean
}

export interface ServerAckResult {
  ok: boolean
  reason?: string
}

export function isServerAckSatisfied(
  source: { type: string; url: string },
  existingRecord: InstallRecord | null,
  ctx: ServerAckCtx
): ServerAckResult {
  if (existingRecord) return { ok: true }
  if (ctx.blanketBypass) return { ok: true }
  for (const pattern of ctx.allowlist) {
    if (matchAllowed(pattern, source.url)) return { ok: true }
  }
  return { ok: false, reason: 'plugin.lifecycle.unsigned_not_allowed' }
}

// Match by scheme + host + path-prefix. Non-URL patterns (no scheme) are
// rejected — we want operators to think in terms of concrete endpoints.
function matchAllowed(pattern: string, url: string): boolean {
  if (!pattern.includes('://')) return false
  let p: URL
  let u: URL
  try {
    p = new URL(pattern)
    u = new URL(url)
  } catch {
    return false
  }
  if (p.protocol !== u.protocol) return false
  if (p.host !== u.host) return false
  return u.pathname === p.pathname || u.pathname.startsWith(p.pathname)
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      if (
        Array.isArray(arr) &&
        arr.every((x): x is string => typeof x === 'string')
      ) {
        return arr.map((s) => s.trim()).filter(Boolean)
      }
      return []
    } catch {
      return []
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
