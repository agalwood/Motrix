export interface ParsedRemoteEndpoint {
  /** Canonical websocket base URL, without a trailing slash. */
  baseUrl: string
  /** Effective port, including the websocket protocol default. */
  port: number
}

export const REMOTE_ENDPOINT_MAX_LENGTH = 4_096

const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/iu
const PERCENT_TRIPLET = /%([0-9a-f]{2})/giu
const INVALID_PERCENT_ENCODING = /%(?![0-9a-f]{2})/iu

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function hasUserInfoSyntax(value: string): boolean {
  const schemeEnd = value.indexOf('://')
  if (schemeEnd === -1) return false
  const suffix = value.slice(schemeEnd + 3)
  const delimiterOffset = suffix.search(/[/?#]/u)
  const authority =
    delimiterOffset === -1 ? suffix : suffix.slice(0, delimiterOffset)
  return authority.includes('@')
}

function hasLayeredEncodedPathSeparator(value: string): boolean {
  let candidate = value
  while (true) {
    if (ENCODED_PATH_SEPARATOR.test(candidate)) return true
    const decoded = candidate.replace(
      PERCENT_TRIPLET,
      (_triplet, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))
    )
    if (decoded === candidate) return false
    candidate = decoded
  }
}

function canonicalBaseUrl(url: URL): string {
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${basePath}`
}

/**
 * Parse the user-configured remote endpoint.
 *
 * `remoteUrl` is a WS/WSS *base URL*. A non-root path is preserved as
 * a reverse-proxy prefix. Query strings, fragments, credentials, whitespace,
 * controls, backslashes and encoded path separators are rejected because
 * different parsers/proxies could otherwise route one spelling differently.
 *
 * URL serialization gives us one canonical routing authority: host casing and
 * explicit default ports are normalized, and trailing slashes do not create a
 * second logical endpoint. This function never trims, upgrades, or downgrades
 * the configured transport. MBP1 protects application content on both schemes;
 * callers surface the additional transport risk of `ws://` to the user.
 */
export function parseRemoteEndpoint(input: string): ParsedRemoteEndpoint {
  if (
    input.length === 0 ||
    input.length > REMOTE_ENDPOINT_MAX_LENGTH ||
    hasAsciiControl(input) ||
    /\p{White_Space}/u.test(input) ||
    input.includes('\\') ||
    hasLayeredEncodedPathSeparator(input) ||
    INVALID_PERCENT_ENCODING.test(input) ||
    hasUserInfoSyntax(input) ||
    input.includes('?') ||
    input.includes('#')
  ) {
    throw new Error('remoteUrl is ambiguous or outside the accepted bound')
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('remoteUrl must be a valid ws:// or wss:// URL')
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('remoteUrl must use ws:// or wss://')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('remoteUrl must not include credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('remoteUrl must not include a query string or fragment')
  }

  const baseUrl = canonicalBaseUrl(url)
  if (baseUrl.length > REMOTE_ENDPOINT_MAX_LENGTH) {
    throw new Error('remoteUrl canonical form is too long')
  }
  let reparsed: URL
  try {
    reparsed = new URL(baseUrl)
  } catch {
    throw new Error('remoteUrl canonical form is invalid')
  }
  if (canonicalBaseUrl(reparsed) !== baseUrl) {
    throw new Error('remoteUrl canonical form is unstable')
  }

  const port =
    url.port === '' ? (url.protocol === 'wss:' ? 443 : 80) : Number(url.port)

  return { baseUrl, port }
}

export function normalizeRemoteEndpoint(input: string): string {
  return parseRemoteEndpoint(input).baseUrl
}
