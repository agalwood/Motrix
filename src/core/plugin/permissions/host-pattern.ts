const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

type PatternScheme = 'http:' | 'https:' | '*'

type PatternHost =
  | { kind: 'any' }
  | { kind: 'exact'; value: string }
  | { kind: 'subdomain'; value: string }

export interface HostPermissionPattern {
  scheme: PatternScheme
  host: PatternHost
  pathExpression: RegExp
}

const parsedPatternCache = new Map<string, HostPermissionPattern | null>()

/**
 * Parse the manifest-v1 browser match-pattern subset used by Motrix.
 * Invalid patterns fail closed instead of being treated as regular
 * expressions over an untrusted URL string.
 */
export function parseHostPermissionPattern(
  pattern: string
): HostPermissionPattern | undefined {
  const cached = parsedPatternCache.get(pattern)
  if (cached !== undefined) return cached ?? undefined
  const parsed = parseHostPermissionPatternUncached(pattern)
  parsedPatternCache.set(pattern, parsed ?? null)
  return parsed
}

function parseHostPermissionPatternUncached(
  pattern: string
): HostPermissionPattern | undefined {
  if (pattern === '<all_urls>') {
    return {
      scheme: '*',
      host: { kind: 'any' },
      pathExpression: /^\/.*$/,
    }
  }

  const separator = pattern.indexOf('://')
  if (separator <= 0) return undefined
  const rawScheme = pattern.slice(0, separator)
  const scheme: PatternScheme | undefined =
    rawScheme === '*'
      ? '*'
      : rawScheme === 'http' || rawScheme === 'https'
        ? `${rawScheme}:`
        : undefined
  if (!scheme) return undefined

  const authorityAndPath = pattern.slice(separator + 3)
  const pathStart = authorityAndPath.indexOf('/')
  if (pathStart < 0) return undefined
  const rawHost = authorityAndPath.slice(0, pathStart)
  const rawPath = authorityAndPath.slice(pathStart)
  if (
    rawHost.length === 0 ||
    rawPath.length === 0 ||
    rawPath.includes('#') ||
    /[\s\\@?#%]/.test(rawHost)
  ) {
    return undefined
  }

  const host = parsePatternHost(rawHost)
  if (!host) return undefined

  const normalizedPath = uppercasePercentEscapes(rawPath)
  const escaped = normalizedPath.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return {
    scheme,
    host,
    pathExpression: new RegExp(`^${escaped.replace(/\*/g, '.*')}$`),
  }
}

export function matchesHostPermission(
  pattern: string,
  rawUrl: string
): boolean {
  const parsedPattern = parseHostPermissionPattern(pattern)
  if (!parsedPattern) return false
  // WHATWG URL drops syntactically present empty userinfo (`https://@h/`).
  // Inspect the raw authority first so every credential form fails closed.
  if (hasAuthorityUserInfo(rawUrl)) return false

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (
    !HTTP_PROTOCOLS.has(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return false
  }
  if (parsedPattern.scheme !== '*' && parsedPattern.scheme !== url.protocol) {
    return false
  }

  const host = canonicalUrlHost(url.hostname)
  if (!host || !matchesPatternHost(parsedPattern.host, host)) return false

  const pathAndQuery = uppercasePercentEscapes(`${url.pathname}${url.search}`)
  return parsedPattern.pathExpression.test(pathAndQuery)
}

/**
 * Detect syntactically-present userinfo before WHATWG URL normalization can
 * erase an empty username/password. Accepts both absolute URLs and
 * scheme-relative references such as redirect `Location: //@host/path`.
 */
export function hasAuthorityUserInfo(rawUrl: string): boolean {
  const trimmed = rawUrl.trimStart()
  const schemeAuthority = /^[a-z][a-z\d+.-]*:\/\//i.exec(trimmed)
  const authorityStart = schemeAuthority
    ? schemeAuthority[0].length
    : trimmed.startsWith('//')
      ? 2
      : -1
  if (authorityStart < 0) return false
  let authorityEnd = trimmed.length
  for (const separator of ['/', '?', '#', '\\']) {
    const index = trimmed.indexOf(separator, authorityStart)
    if (index >= 0 && index < authorityEnd) authorityEnd = index
  }
  return trimmed.slice(authorityStart, authorityEnd).includes('@')
}

export function matchesAnyHostPermission(
  patterns: ReadonlyArray<string> | undefined,
  rawUrl: string
): boolean {
  return (patterns ?? []).some((pattern) =>
    matchesHostPermission(pattern, rawUrl)
  )
}

function parsePatternHost(rawHost: string): PatternHost | undefined {
  if (rawHost === '*') return { kind: 'any' }

  if (rawHost.startsWith('*.')) {
    const suffix = rawHost.slice(2)
    if (suffix.includes('*')) return undefined
    const value = canonicalManifestHost(suffix)
    if (!value || value.startsWith('[')) return undefined
    return { kind: 'subdomain', value }
  }

  if (rawHost.includes('*')) return undefined
  const value = canonicalManifestHost(rawHost)
  return value ? { kind: 'exact', value } : undefined
}

function canonicalManifestHost(rawHost: string): string | undefined {
  // Manifest v1 intentionally has no port grammar. A colon is valid only
  // inside a bracketed IPv6 literal.
  if (
    rawHost.includes(':') &&
    !(rawHost.startsWith('[') && rawHost.endsWith(']'))
  ) {
    return undefined
  }
  try {
    const parsed = new URL(`http://${rawHost}/`)
    if (parsed.username || parsed.password || parsed.port) return undefined
    return canonicalUrlHost(parsed.hostname)
  } catch {
    return undefined
  }
}

function canonicalUrlHost(hostname: string): string | undefined {
  if (hostname.length === 0) return undefined
  const lower = hostname.toLowerCase()
  if (lower.startsWith('[')) return lower.endsWith(']') ? lower : undefined
  const withoutTrailingDot = lower.endsWith('.') ? lower.slice(0, -1) : lower
  return withoutTrailingDot.length > 0 ? withoutTrailingDot : undefined
}

function matchesPatternHost(pattern: PatternHost, host: string): boolean {
  if (pattern.kind === 'any') return true
  if (pattern.kind === 'exact') return pattern.value === host
  return host === pattern.value || host.endsWith(`.${pattern.value}`)
}

function uppercasePercentEscapes(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, (sequence) => sequence.toUpperCase())
}
