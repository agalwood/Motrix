import type { ProxySettings } from '@shared/types/settings'

export interface Aria2ProxyOptions {
  allProxy: string
  noProxy: string
}

export function proxyToAria2Options(
  p: ProxySettings
): Aria2ProxyOptions | null {
  if (!p.enabled || !p.scopes.download) return null
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
  if (!p.host || p.port <= 0) return null
  const url = proxyToUrl(p)
  const rules = p.protocol === 'socks5' ? `socks5=${url}` : url
  return { proxyRules: rules, proxyBypassRules: p.bypass.join(',') }
}

export function proxyToFetchUrl(p: ProxySettings): string | null {
  if (!p.enabled || !p.scopes.updateTrackers) return null
  if (!p.host || p.port <= 0) return null
  return proxyToUrl(p)
}

export function proxyToUrl(p: ProxySettings): string {
  const auth = p.user
    ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}@`
    : ''
  const host =
    p.host.includes(':') && !p.host.startsWith('[') ? `[${p.host}]` : p.host
  return `${p.protocol}://${auth}${host}:${p.port}`
}
