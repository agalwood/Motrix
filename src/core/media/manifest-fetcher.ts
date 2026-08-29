const DEFAULT_MAX = 5 * 1024 * 1024

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Preserve the HTTP error when body cancellation also fails.
  }
}

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
    await cancelResponseBody(res)
    throw new Error(`manifest fetch failed: HTTP ${res.status}`)
  }
  const text = await res.text()
  const max = opts.maxBytes ?? DEFAULT_MAX
  if (text.length > max) {
    throw new Error(`manifest too large: ${text.length} > ${max}`)
  }
  return text
}
