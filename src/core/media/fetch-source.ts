import { admitHttpSource } from '@core/task/source-admission'
import { resolveUri } from './segment-plan'

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Preserve the original failure when body cancellation also fails.
  }
}

/** Validate each redirect before fetching another media resource. */
export async function fetchSource(
  url: string,
  opts: {
    headers?: Record<string, string>
    fetchImpl?: typeof fetch
  } = {}
): Promise<Response> {
  url = admitHttpSource(url)
  const doFetch = opts.fetchImpl ?? fetch
  const signal = AbortSignal.timeout(10_000)
  let headers = opts.headers ?? {}
  for (let redirects = 0; ; redirects++) {
    const response = await doFetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await cancelResponseBody(response)
    const location = response.headers.get('location')
    if (!location || redirects >= 5)
      throw new Error('media redirect limit or missing location')
    const next = resolveUri(url, location)
    if (new URL(next).origin !== new URL(url).origin) {
      headers = Object.fromEntries(
        Object.entries(headers).filter(
          ([key]) =>
            ![
              'authorization',
              'cookie',
              'proxy-authorization',
              'host',
            ].includes(key.toLowerCase())
        )
      )
    }
    url = next
  }
}
