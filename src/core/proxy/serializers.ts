import type { ProxySettings } from '@shared/types/settings'

export interface Aria2ProxyOptions {
  allProxy: string
  noProxy: string
}

export interface DownloadProxyRequestOptions {
  proxy: string
  noProxy: string
}

export function proxyToAria2Options(
  p: ProxySettings
): Aria2ProxyOptions | null {
  if (!p.enabled || !p.scopes.download) return null
  if (hasUnsafeProxyControls(p)) return null
  if (p.protocol === 'socks5') return null
  if (!p.host || p.port <= 0) return null
  return {
    allProxy: proxyToUrl(p),
    noProxy: p.bypass.join(','),
  }
}

export function proxyToElectronConfig(
  p: ProxySettings
): { proxyRules: string; proxyBypassRules: string } | null {
  if (!p.enabled || !p.scopes.updateApp) return null
  if (hasUnsafeProxyControls(p)) return null
  if (!p.host || p.port <= 0) return null
  const url = proxyToUrl(p)
  const rules = p.protocol === 'socks5' ? `socks5=${url}` : url
  return { proxyRules: rules, proxyBypassRules: p.bypass.join(',') }
}

export function proxyToFetchUrl(p: ProxySettings): string | null {
  if (!p.enabled || !p.scopes.updateTrackers) return null
  if (hasUnsafeProxyControls(p)) return null
  if (!p.host || p.port <= 0) return null
  return proxyToUrl(p)
}

/**
 * Snapshot the current global download-proxy policy for a short-lived HTTP
 * request. Unlike proxyToAria2Options(), SOCKS5 remains usable here because
 * the metadata client can speak SOCKS5 directly.
 */
export function proxyToDownloadRequestOptions(
  p: ProxySettings
): DownloadProxyRequestOptions | null {
  if (!p.enabled || !p.scopes.download) return null
  if (hasUnsafeProxyControls(p)) return null
  if (!p.host || p.port <= 0) return null
  return {
    proxy: proxyToUrl(p),
    noProxy: p.bypass.join(','),
  }
}

export function proxyToUrl(p: ProxySettings): string {
  if (hasUnsafeProxyControls(p)) {
    throw new TypeError('Proxy fields must not contain control characters')
  }
  const auth = p.user
    ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}@`
    : ''
  const host =
    p.host.includes(':') && !p.host.startsWith('[') ? `[${p.host}]` : p.host
  return `${p.protocol}://${auth}${host}:${p.port}`
}

function hasUnsafeProxyControls(p: ProxySettings): boolean {
  return [p.host, p.user, p.password, ...p.bypass].some(hasC0OrDel)
}

function hasC0OrDel(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}
