const DEFAULT_MAX = 5 * 1024 * 1024

export async function fetchManifest(
  url: string,
  opts: {
    headers?: Record<string, string>
    fetchImpl?: typeof fetch
    maxBytes?: number
  } = {}
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(url, {
    method: 'GET',
    headers: opts.headers ?? {},
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`manifest fetch failed: HTTP ${res.status}`)
  }
  const text = await res.text()
  const max = opts.maxBytes ?? DEFAULT_MAX
  if (text.length > max) {
    throw new Error(`manifest too large: ${text.length} > ${max}`)
  }
  return text
}
