import type { Cookie } from '@motrix/mdxp'
import type { NetworkMediaCredentialObservation } from '@/background/capture/MediaCredentialStore'

const FORWARDED_HEADERS: ReadonlyMap<string, string> = new Map([
  ['accept', 'Accept'],
  ['accept-language', 'Accept-Language'],
  ['origin', 'Origin'],
  ['referer', 'Referer'],
  ['user-agent', 'User-Agent'],
  ['x-requested-with', 'X-Requested-With'],
])
const MAX_HEADER_VALUE_LENGTH = 8_192

export interface ResourceCredentials {
  cookies: Cookie[]
  headers: Record<string, string>
}

/**
 * Defense in depth for records already present in session storage. Secret or
 * malformed headers are never forwarded, even if an older extension build
 * persisted them before the current capture policy was installed.
 */
export function safeMediaRequestHeaders(
  input: Record<string, string> | undefined
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(input ?? {})) {
    const name = FORWARDED_HEADERS.get(rawName.trim().toLowerCase())
    const value = rawValue.trim()
    if (
      !name ||
      !value ||
      value.length > MAX_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(value)
    ) {
      continue
    }
    result[name] = value
  }
  return result
}

function requestHeader(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const entry = Object.entries(headers).find(
    ([candidate]) => candidate.trim().toLowerCase() === name.toLowerCase()
  )
  return entry?.[1]
}

function originOnly(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin}/`
      : undefined
  } catch {
    return undefined
  }
}

function observedCookies(
  value: string | undefined,
  resourceUrl: string
): Cookie[] {
  let url: URL
  try {
    url = new URL(resourceUrl)
  } catch {
    return []
  }
  const cookies: Cookie[] = []
  for (const item of value?.split(';') ?? []) {
    const separator = item.indexOf('=')
    if (separator <= 0) continue
    const name = item.slice(0, separator).trim()
    const cookieValue = item.slice(separator + 1).trim()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject header injection and NUL-delimited ambiguity
    if (!name || /[\r\n\u0000]/.test(name + cookieValue)) continue
    cookies.push({
      name,
      value: cookieValue,
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      httpOnly: false,
      sameSite: 'unspecified',
    })
  }
  return cookies
}

export async function buildResourceCredentials(options: {
  url: string
  observation?: NetworkMediaCredentialObservation
  userAgent: string
}): Promise<ResourceCredentials> {
  if (!options.observation) return { cookies: [], headers: {} }
  const captured = safeMediaRequestHeaders(options.observation.requestHeaders)
  const headers: Record<string, string> = { ...captured }
  const referer = originOnly(captured.Referer)
  const origin = originOnly(captured.Origin)
  if (referer) headers.Referer = referer
  else delete headers.Referer
  if (origin) headers.Origin = origin.slice(0, -1)
  else delete headers.Origin
  headers['User-Agent'] = captured['User-Agent'] ?? options.userAgent
  const cookies = observedCookies(
    requestHeader(options.observation.requestHeaders, 'cookie'),
    options.url
  )
  return {
    cookies,
    headers,
  }
}
