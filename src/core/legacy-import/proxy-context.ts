import type { LegacyProxyOptions } from '@core/engine/engine-adapter'
import { normalizeLegacyAria2ProxyUrl } from '@core/proxy/legacy-aria2-proxy'
import { AppError, ErrorCode } from '@shared/errors'

type RequestValues = Readonly<Record<string, readonly string[]>>
const changed = () =>
  new AppError(ErrorCode.InvalidSelection, 'legacyImport.errors.changedSource')

/** Values have already been filtered and merged by the session parser. */
export function resolveLegacyProxyOptions(
  values: RequestValues
): LegacyProxyOptions {
  const value = (key: string) => values[key]?.at(-1) ?? ''
  const proxyFor = (prefix: string) => {
    const raw = value(prefix)
    if (!raw) return ''
    const proxy = normalizeLegacyAria2ProxyUrl(raw)
    if (!proxy) throw changed()
    try {
      // Dedicated credentials are raw text, unlike percent-encoded URI userinfo.
      for (const [suffix, property] of [
        ['user', 'username'],
        ['passwd', 'password'],
      ] as const) {
        const key = `${prefix}-${suffix}`
        if (values[key]?.length)
          proxy[property] = encodeURIComponent(value(key))
      }
      if (!proxy.username) proxy.password = ''
      return proxy.href
    } catch {
      throw changed()
    }
  }
  return {
    allProxy: proxyFor('all-proxy'),
    httpProxy: proxyFor('http-proxy'),
    httpsProxy: proxyFor('https-proxy'),
    ftpProxy: proxyFor('ftp-proxy'),
    noProxy: value('no-proxy'),
    proxyMethod: value('proxy-method') === 'tunnel' ? 'tunnel' : 'get',
  }
}

export function parseLegacySystem(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
    if (!value || Array.isArray(value) || typeof value !== 'object')
      throw changed()
    return value as Record<string, unknown>
  } catch {
    throw changed()
  }
}
