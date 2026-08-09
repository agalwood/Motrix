export interface SystemProxyResult {
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
}

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
