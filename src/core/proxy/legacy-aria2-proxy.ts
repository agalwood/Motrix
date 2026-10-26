import { normalizeAria2TaskProxyUrl } from './aria2-proxy-routing'

/** Reproduce the legacy aria2 proxy option handler, which always uses HTTP transport. */
export function normalizeLegacyAria2ProxyUrl(input: string): URL | null {
  const ftp = input.startsWith('ftp://')
  const accepted = normalizeAria2TaskProxyUrl(
    ftp ? `http://${input.slice('ftp://'.length)}` : input
  )
  if (!accepted) return null
  // HttpProxyOptionHandler parses the original scheme's default port before
  // changing the scheme to HTTP: https://host means plain HTTP on port 443,
  // and ftp://host means plain HTTP on port 21.
  const proxy = ftp ? new URL(input) : accepted
  const port =
    proxy.port || (ftp ? '21' : proxy.protocol === 'https:' ? '443' : '80')
  proxy.protocol = 'http:'
  proxy.port = port
  return proxy
}
