import {
  extractAria2ProxyCredentials,
  stripAria2ProxyCredentials,
} from '@core/proxy/aria2-proxy-routing'
import { normalizeLegacyAria2ProxyUrl } from '@core/proxy/legacy-aria2-proxy'
import type { EngineTaskOptions } from '@shared/types/engine-task-options'
import type { LegacyProxyOptions } from '../engine-adapter'

const proxyOptions = [
  ['allProxy', 'all-proxy'],
  ['httpProxy', 'http-proxy'],
  ['httpsProxy', 'https-proxy'],
  ['ftpProxy', 'ftp-proxy'],
] as const

/** Pin empty values too: none of the current profile's routes or credentials may leak in. */
export function legacyProxyOptions(
  context: LegacyProxyOptions
): Record<string, string> {
  const options: Record<string, string> = {}
  for (const [property, option] of proxyOptions) {
    const value = context[property]
    if (typeof value !== 'string') throw new TypeError('Invalid legacy proxy')
    let authority = ''
    let username = ''
    let password = ''
    if (value) {
      const normalized = normalizeLegacyAria2ProxyUrl(value)
      const credentials =
        normalized && extractAria2ProxyCredentials(normalized.href)
      const stripped = normalized && stripAria2ProxyCredentials(normalized.href)
      if (!credentials || !stripped) throw new TypeError('Invalid legacy proxy')
      authority = stripped
      ;({ username, password } = credentials)
    }
    options[option] = authority
    options[`${option}-user`] = username
    options[`${option}-passwd`] = password
  }
  if (
    typeof context.noProxy !== 'string' ||
    [...context.noProxy].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    }) ||
    !['get', 'tunnel'].includes(context.proxyMethod)
  )
    throw new TypeError('Invalid legacy proxy')
  options['no-proxy'] = context.noProxy
  options['proxy-method'] = context.proxyMethod
  return options
}

/** Check effective native routes and credentials without returning or logging their values. */
export function legacyProxyMatches(
  options: EngineTaskOptions,
  context: LegacyProxyOptions
): boolean {
  try {
    const expected = legacyProxyOptions(context)
    return Object.entries(expected).every(([key, value]) => {
      const actual = options[key] ?? ''
      if (!proxyOptions.some(([, option]) => option === key) || !value)
        return actual === value
      if (typeof actual !== 'string') return false
      const expectedUrl = normalizeLegacyAria2ProxyUrl(value)
      const actualUrl = normalizeLegacyAria2ProxyUrl(actual)
      return expectedUrl !== null && expectedUrl.href === actualUrl?.href
    })
  } catch {
    return false
  }
}
