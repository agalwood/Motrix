import type { ProxySettings } from '@shared/types/settings'

export function proxyToAria2Options(
  p: ProxySettings
): { allProxy: string; noProxy: string } | null {
  if (!p.enabled || !p.scopes.download) return null
  if (!p.host || p.port <= 0) return null
  return {
    allProxy: buildProxyUrl(p),
    noProxy: p.bypass.join(','),
  }
}

export function proxyToElectronConfig(
  p: ProxySettings
): { proxyRules: string; proxyBypassRules: string } | null {
  if (!p.enabled || !p.scopes.updateApp) return null
  if (!p.host || p.port <= 0) return null
  const url = buildProxyUrl(p)
  const rules = p.protocol === 'socks5' ? `socks5=${url}` : url
  return { proxyRules: rules, proxyBypassRules: p.bypass.join(',') }
}

export function proxyToFetchUrl(p: ProxySettings): string | null {
  if (!p.enabled || !p.scopes.updateTrackers) return null
  if (!p.host || p.port <= 0) return null
  return buildProxyUrl(p)
}

function buildProxyUrl(p: ProxySettings): string {
  const auth = p.user
    ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}@`
    : ''
  return `${p.protocol}://${auth}${p.host}:${p.port}`
}
