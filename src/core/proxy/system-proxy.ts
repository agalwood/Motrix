import type { SystemProxyResult } from '@shared/types/system-proxy'

export type { SystemProxyResult } from '@shared/types/system-proxy'

/**
 * Parses Electron `session.resolveProxy(url)` output.
 *
 * Examples:
 *   "DIRECT"                         → null
 *   "PROXY 127.0.0.1:8080"           → http
 *   "HTTPS 1.2.3.4:443"              → https
 *   "SOCKS5 192.168.1.1:1080"        → socks5
 *   "PROXY a:1; PROXY b:2"           → first non-DIRECT
 */
export function parseElectronProxyChain(s: string): SystemProxyResult | null {
  if (!s) return null
  for (const entry of s.split(';').map((e) => e.trim())) {
    if (!entry || entry === 'DIRECT') continue
    const [type, hostPort] = entry.split(/\s+/)
    if (!hostPort) continue
    const [host, portStr] = hostPort.split(':')
    const port = Number.parseInt(portStr ?? '', 10)
    if (!host || !Number.isFinite(port) || port <= 0) continue

    const protocol =
      type === 'PROXY' || type === 'HTTP'
        ? 'http'
        : type === 'HTTPS'
          ? 'https'
          : type === 'SOCKS5' || type === 'SOCKS'
            ? 'socks5'
            : null
    if (!protocol) continue

    return { protocol, host, port }
  }
  return null
}

const PROXY_ENVIRONMENT_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Parses the conventional proxy variables inherited by a Server process. */
export function parseProxyEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): SystemProxyResult | null {
  const raw = PROXY_ENVIRONMENT_KEYS.map((key) =>
    environment[key]?.trim()
  ).find((value): value is string => Boolean(value))
  if (!raw) return null

  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch {
    return null
  }
  const protocol =
    url.protocol === 'http:'
      ? 'http'
      : url.protocol === 'https:'
        ? 'https'
        : ['socks:', 'socks5:', 'socks5h:'].includes(url.protocol)
          ? 'socks5'
          : null
  if (!protocol || !url.hostname) return null
  const defaultPort =
    protocol === 'http' ? 80 : protocol === 'https' ? 443 : 1080
  const port = url.port ? Number.parseInt(url.port, 10) : defaultPort
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null

  const rawBypass =
    environment.NO_PROXY?.trim() || environment.no_proxy?.trim() || ''
  const bypass = rawBypass
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 64)
  const user = decodeUrlCredential(url.username)
  const password = decodeUrlCredential(url.password)

  return {
    protocol,
    host: url.hostname,
    port,
    ...(user ? { user } : {}),
    ...(password ? { password } : {}),
    ...(bypass.length > 0 ? { bypass } : {}),
  }
}
