import { BlockList, isIP } from 'node:net'

const EXPLICIT_PROXY_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:\/\//
const ARIA2_STRIP = /^[\r\n\t ]+|[\r\n\t ]+$/g
const ARIA2_UNSIGNED_INTEGER = /^[\t\n\v\f\r ]*[+-]?\d+[\t\n\v\f\r ]*$/
const MAX_ARIA2_UNSIGNED_INTEGER = 2_147_483_647

export type ProxyRouteDecision = 'direct' | 'proxy' | 'unsupported'

export interface Aria2ProxyCredentials {
  username: string
  password: string
}

/**
 * Normalize a proxy authority for the HTTP clients used by core services.
 * aria2 accepts a scheme-less proxy value as HTTP, so preserve that behavior
 * instead of requiring callers to special-case persisted or task-level input.
 */
export function normalizeProxyUrl(input: string): URL | null {
  if (hasC0SpaceOrDel(input) || input.includes('\\')) return null
  const value = input
  if (!value || value.includes('?') || value.includes('#')) return null
  const candidate = EXPLICIT_PROXY_SCHEME.test(value)
    ? value
    : `http://${value}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }

  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:' &&
    url.protocol !== 'socks5:'
  ) {
    return null
  }
  const scheme = rawUrlScheme(candidate)
  const hostname = rawUrlHostname(candidate)
  if (
    scheme !== url.protocol.slice(0, -1) ||
    !hostname ||
    !equivalentUrlHostname(hostname, unbracketHostname(url.hostname))
  ) {
    return null
  }
  if (
    !url.hostname ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    return null
  }
  if (url.port === '0') return null

  return url
}

/**
 * Normalize the per-download `all-proxy` syntax accepted by aria2. Unlike the
 * application-wide SOCKS setting, task proxies do not pass through the local
 * bridge and aria2 itself cannot consume a socks5:// URI.
 */
export function normalizeAria2TaskProxyUrl(input: string): URL | null {
  const url = parseAria2ProxyUrl(input)
  return url && url.protocol !== 'socks5:' ? url : null
}

/** Remove URI userinfo without canonicalizing aria2's accepted authority. */
export function stripAria2ProxyCredentials(input: string): string | null {
  if (!parseAria2ProxyUrl(input)) return null
  const scheme = EXPLICIT_PROXY_SCHEME.exec(input)
  const authorityStart = scheme?.[0].length ?? 0
  const delimiter = input.lastIndexOf('@')
  return delimiter < authorityStart
    ? input
    : `${input.slice(0, authorityStart)}${input.slice(delimiter + 1)}`
}

/**
 * Resolve the credential values aria2's dedicated proxy options expect.
 * aria2 percent-decodes URI userinfo before authentication, while standalone
 * `*-proxy-user` / `*-proxy-passwd` values are consumed as plain text.
 */
export function extractAria2ProxyCredentials(
  input: string
): Aria2ProxyCredentials | null {
  const url = parseAria2ProxyUrl(input)
  if (!url) return null

  try {
    const credentials = {
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    }
    // aria2 reparses argv values through a line-oriented config stream. A
    // decoded CR/LF would become a new option; other controls are likewise
    // not portable between its URI parser and dedicated credential options.
    if (hasC0OrDel(credentials.username) || hasC0OrDel(credentials.password)) {
      return null
    }
    return credentials
  } catch {
    return null
  }
}

/**
 * Parse syntax consumed by aria2 itself. This intentionally does not require
 * raw hostname text to equal WHATWG's canonical form: aria2 accepts legacy
 * numeric IPv4 authorities such as 127.1. Metadata clients still use the
 * stricter normalizeProxyUrl() and therefore fail closed when they cannot
 * reproduce that authority exactly.
 */
function parseAria2ProxyUrl(input: string): URL | null {
  if (hasC0SpaceOrDel(input) || input.includes('\\')) return null
  if (!input || input.includes('?') || input.includes('#')) return null
  const candidate = EXPLICIT_PROXY_SCHEME.test(input)
    ? input
    : `http://${input}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:' &&
    url.protocol !== 'socks5:'
  ) {
    return null
  }
  if (rawUrlScheme(candidate) !== url.protocol.slice(0, -1)) return null
  if (
    !rawUrlHostname(candidate) ||
    !url.hostname ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash ||
    url.port === '0'
  ) {
    return null
  }
  return url
}

/**
 * Decide the route for one HTTP(S) hop using aria2's no-proxy semantics.
 * Call this again for every redirect target; a bypass decision for one origin
 * must not be inherited by another origin.
 */
export function decideAria2ProxyRoute(
  target: string | URL,
  noProxy = ''
): ProxyRouteDecision {
  if (
    (typeof target === 'string' && hasC0OrDel(target)) ||
    hasC0OrDel(noProxy)
  ) {
    return 'unsupported'
  }
  const parsed = parseHttpTarget(target)
  if (!parsed) return 'unsupported'

  const hostname = unbracketHostname(parsed.hostname)
  if (!hostname) return 'unsupported'

  const entries = noProxy
    .split(',')
    .map((entry) => entry.replace(ARIA2_STRIP, ''))
    .filter(Boolean)

  for (const entry of entries) {
    const slash = entry.indexOf('/')
    if (slash === -1) {
      if (aria2DomainMatch(hostname, entry)) return 'direct'
      continue
    }

    const bits = parseAria2UnsignedInteger(entry.slice(slash + 1))
    if (bits === null) continue

    const cidrMatch = inAria2CidrBlock(entry.slice(0, slash), hostname, bits)
    if (cidrMatch === 'unsupported') return 'unsupported'
    if (cidrMatch) return 'direct'
  }

  return 'proxy'
}

function parseHttpTarget(target: string | URL): { hostname: string } | null {
  let url: URL
  try {
    url = typeof target === 'string' ? new URL(target) : target
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  // WHATWG URL lowercases and canonicalizes hostnames. aria2 deliberately
  // compares no-proxy domain entries against the original authority text, so
  // retain it whenever the caller still has the raw URL string. This matters
  // for case-sensitive entries and non-canonical numeric forms such as 127.1.
  if (typeof target !== 'string') return { hostname: url.hostname }

  const hostname = rawUrlHostname(target)
  if (!hostname) return null
  // Avoid letting WHATWG-only host canonicalization turn a probe into a
  // request aria2 would route or resolve differently (percent-encoded hosts,
  // legacy IPv4 numbers, IDN punycode, or alternate IPv6 spellings).
  const scheme = rawUrlScheme(target)
  if (scheme !== 'http' && scheme !== 'https') return null
  if (!equivalentUrlHostname(hostname, unbracketHostname(url.hostname))) {
    return null
  }
  return { hostname }
}

function rawUrlScheme(input: string): string | null {
  const match = /^[\r\n\t ]*([A-Za-z][A-Za-z\d+.-]*):\/\//.exec(input)
  return match?.[1] ?? null
}

function rawUrlHostname(input: string): string | null {
  const match = /^[\r\n\t ]*[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/.exec(input)
  if (!match?.[1]) return null

  const authority = match[1]
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1)
  if (hostAndPort.startsWith('[')) {
    const closingBracket = hostAndPort.indexOf(']')
    return closingBracket > 1 ? hostAndPort.slice(1, closingBracket) : null
  }

  const portSeparator = hostAndPort.lastIndexOf(':')
  return portSeparator === -1
    ? hostAndPort
    : hostAndPort.slice(0, portSeparator)
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

function equivalentUrlHostname(raw: string, normalized: string): boolean {
  if (raw.toLowerCase() === normalized.toLowerCase()) return true
  if (isIP(raw) !== 6 || isIP(normalized) !== 6) return false
  try {
    return (
      unbracketHostname(new URL(`http://[${raw}]/`).hostname).toLowerCase() ===
      normalized.toLowerCase()
    )
  } catch {
    return false
  }
}

function hasC0OrDel(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function hasC0SpaceOrDel(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x20 || codePoint === 0x7f) return true
  }
  return false
}

function aria2DomainMatch(hostname: string, entry: string): boolean {
  if (entry.startsWith('.') && isIP(hostname) === 0) {
    return hostname.endsWith(entry)
  }
  return hostname === entry
}

function parseAria2UnsignedInteger(value: string): number | null {
  if (!ARIA2_UNSIGNED_INTEGER.test(value)) return null
  const parsed = Number(value)
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_ARIA2_UNSIGNED_INTEGER
  ) {
    return null
  }
  return parsed
}

function inAria2CidrBlock(
  network: string,
  hostname: string,
  bits: number
): boolean | 'unsupported' {
  const networkFamily = isIP(network)
  const hostnameFamily = isIP(hostname)
  if (networkFamily === 0 || networkFamily !== hostnameFamily) return false

  const addressType = networkFamily === 4 ? 'ipv4' : 'ipv6'
  const prefix = Math.min(bits, networkFamily === 4 ? 32 : 128)
  try {
    const block = new BlockList()
    block.addSubnet(network, prefix, addressType)
    return block.check(hostname, addressType)
  } catch {
    // Both addresses passed Node's numeric-host parser. If its subnet parser
    // still cannot represent them, do not guess a route that could diverge
    // from aria2.
    return 'unsupported'
  }
}
