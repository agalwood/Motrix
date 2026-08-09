/**
 * Hop-by-hop and protocol-controlled headers. We strip these before
 * passing headers to aria2 (--header) or our own fetcher. Cookies travel
 * via the `cookies` array and are reconstructed into a single Cookie
 * header at request time; `Host` and `Content-Length` are computed by
 * the HTTP library; the rest are connection-level.
 *
 * Mirrors the list from ② spec §4.1.
 */
const DENYLIST = new Set([
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
])

export function stripHopByHopHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (DENYLIST.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}
