import type { ProxyConfig } from '@shared/types/tracker'

interface TrackerRequestInit {
  method?: string
  signal?: AbortSignal
}

interface TrackerResponse {
  text(): Promise<string>
}

export interface TrackerHttpClient {
  fetch(url: string, init: TrackerRequestInit): Promise<TrackerResponse>
  close(): Promise<void>
}

export async function createTrackerHttpClient(
  proxy?: ProxyConfig
): Promise<TrackerHttpClient> {
  if (!proxy) {
    return {
      fetch: (url, init) => globalThis.fetch(url, init),
      close: async () => undefined,
    }
  }

  // The dispatcher and fetch implementation must come from the same Undici
  // package. Node's global fetch can bundle a different Undici major whose
  // dispatcher handler contract is incompatible with this ProxyAgent.
  const { fetch, ProxyAgent } = await import('undici')
  let uri = proxy.server
  if (proxy.username) {
    const url = new URL(uri)
    url.username = proxy.username
    url.password = proxy.password ?? ''
    uri = url.toString()
  }
  const dispatcher = new ProxyAgent(uri)

  return {
    fetch: (url, init) => fetch(url, { ...init, dispatcher }),
    close: () => dispatcher.close(),
  }
}
