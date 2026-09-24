import { cancelResponseBody, fetchSource } from './fetch-source'

const DEFAULT_MAX = 5 * 1024 * 1024

export async function fetchManifest(
  url: string,
  opts: {
    headers?: Record<string, string>
    fetchImpl?: typeof fetch
    maxBytes?: number
  } = {}
): Promise<string> {
  const res = await fetchSource(url, opts)
  if (!res.ok) {
    await cancelResponseBody(res)
    throw new Error(`manifest fetch failed: HTTP ${res.status}`)
  }
  const max = opts.maxBytes ?? DEFAULT_MAX
  const reader = res.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) throw new Error('manifest too large')
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
