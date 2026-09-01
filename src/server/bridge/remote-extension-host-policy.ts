import {
  isIssuedRemoteExtensionConfig,
  type RemoteExtensionConfig,
} from './remote-extension-config'

const MAX_RAW_HEADER_ENTRIES = 256
const MAX_HOST_LENGTH = 1_024

export type RemoteExtensionHostRejection =
  | 'feature-closed'
  | 'malformed-headers'
  | 'missing-host'
  | 'duplicate-host'
  | 'malformed-host'
  | 'authority-mismatch'

export type RemoteExtensionHostDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RemoteExtensionHostRejection }

const ALLOWED: RemoteExtensionHostDecision = Object.freeze({ ok: true })

function rejected(
  reason: RemoteExtensionHostRejection
): RemoteExtensionHostDecision {
  return Object.freeze({ ok: false, reason })
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index)
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function hasStrictPortSyntax(value: string): boolean {
  let suffix = ''
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']')
    if (closingBracket <= 1 || value.indexOf(']', closingBracket + 1) !== -1) {
      return false
    }
    suffix = value.slice(closingBracket + 1)
    if (suffix !== '' && !suffix.startsWith(':')) return false
  } else {
    const firstColon = value.indexOf(':')
    const lastColon = value.lastIndexOf(':')
    if (firstColon !== lastColon) return false
    suffix = firstColon === -1 ? '' : value.slice(firstColon)
  }
  if (suffix === '') return true

  const port = suffix.slice(1)
  if (!/^[1-9]\d{0,4}$/u.test(port)) return false
  return Number(port) <= 65_535
}

/**
 * Parse an HTTP Host value using the configured WebSocket scheme's matching
 * HTTP effective-port semantics. No request-derived path or forwarded-host
 * input reaches this function.
 */
function canonicalRequestAuthority(
  value: string,
  protocol: 'http:' | 'https:'
): string | null {
  if (
    value.length === 0 ||
    value.length > MAX_HOST_LENGTH ||
    containsAsciiControl(value) ||
    /\p{White_Space}/u.test(value) ||
    value.includes('\\') ||
    value.includes('%') ||
    /[/?#@,]/u.test(value) ||
    !hasStrictPortSyntax(value)
  ) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(`${protocol}//${value}/`)
  } catch {
    return null
  }
  if (
    parsed.protocol !== protocol ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.host === ''
  ) {
    return null
  }
  return parsed.host
}

interface ExpectedAuthority {
  authority: string
  requestProtocol: 'http:' | 'https:'
}

function expectedAuthority(
  config: RemoteExtensionConfig
): ExpectedAuthority | null {
  if (!isIssuedRemoteExtensionConfig(config) || config.status !== 'enabled') {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(config.publicWebSocketBaseUrl)
  } catch {
    return null
  }
  if (
    (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.host === '' ||
    parsed.host !== config.publicWebSocketAuthority
  ) {
    return null
  }
  return {
    authority: parsed.host,
    requestProtocol: parsed.protocol === 'wss:' ? 'https:' : 'http:',
  }
}

/**
 * Validate the original HTTP/1 raw header list before admitting any remote
 * Extension route.
 *
 * Exactly one `Host` field is required even when duplicate fields contain the
 * same value. `X-Forwarded-Host` is deliberately ignored: proxy deployment
 * must preserve the configured public Host rather than asking an untrusted
 * request header to redefine the authority. The fixed rejection codes contain
 * no request or configuration value and are safe for diagnostics.
 */
export function evaluateRemoteExtensionHost(
  config: RemoteExtensionConfig,
  rawHeaders: readonly string[]
): RemoteExtensionHostDecision {
  const expected = expectedAuthority(config)
  if (expected === null) return rejected('feature-closed')
  if (
    !Array.isArray(rawHeaders) ||
    rawHeaders.length > MAX_RAW_HEADER_ENTRIES ||
    rawHeaders.length % 2 !== 0
  ) {
    return rejected('malformed-headers')
  }

  const hosts: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (typeof name !== 'string' || typeof value !== 'string') {
      return rejected('malformed-headers')
    }
    if (name.toLowerCase() === 'host') hosts.push(value)
  }
  if (hosts.length === 0) return rejected('missing-host')
  if (hosts.length !== 1) return rejected('duplicate-host')

  const actual = canonicalRequestAuthority(
    hosts[0] ?? '',
    expected.requestProtocol
  )
  if (actual === null) return rejected('malformed-host')
  return actual === expected.authority
    ? ALLOWED
    : rejected('authority-mismatch')
}
