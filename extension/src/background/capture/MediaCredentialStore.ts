/**
 * A short-lived, background-only record of request context actually observed
 * by webRequest. These values must never be written to extension storage or
 * returned to the Popup: Referer, Origin and Cookie can all contain secrets.
 */
export interface NetworkMediaCredentialObservation {
  tabId: number
  pageUrl: string
  url: string
  observedAt: number
  requestHeaders: Record<string, string>
}

export const MEDIA_CREDENTIAL_TTL_MS = 5 * 60_000
export const MAX_MEDIA_CREDENTIAL_OBSERVATIONS = 512

const PRIVATE_REQUEST_HEADERS = new Map([
  ['accept', 'Accept'],
  ['accept-language', 'Accept-Language'],
  ['cookie', 'Cookie'],
  ['origin', 'Origin'],
  ['referer', 'Referer'],
  ['user-agent', 'User-Agent'],
  ['x-requested-with', 'X-Requested-With'],
])
const MAX_PRIVATE_HEADER_VALUE_LENGTH = 16_384

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function observationKey(tabId: number, pageUrl: string, url: string): string {
  return `${tabId}\u0000${pageUrl}\u0000${url}`
}

function privateHeaders(input: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = PRIVATE_REQUEST_HEADERS.get(rawName.trim().toLowerCase())
    const value = rawValue.trim()
    if (
      !name ||
      !value ||
      value.length > MAX_PRIVATE_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(value)
    ) {
      continue
    }
    result[name] = value
  }
  return result
}

export class MediaCredentialStore {
  private readonly observations = new Map<
    string,
    NetworkMediaCredentialObservation
  >()

  constructor(private readonly now: () => number = Date.now) {}

  remember(observation: NetworkMediaCredentialObservation): void {
    const pageUrl = httpUrl(observation.pageUrl)
    const url = httpUrl(observation.url)
    if (observation.tabId < 0 || !pageUrl || !url) return
    this.prune()
    const key = observationKey(observation.tabId, pageUrl, url)
    this.observations.delete(key)
    this.observations.set(key, {
      tabId: observation.tabId,
      pageUrl,
      url,
      observedAt: observation.observedAt,
      requestHeaders: privateHeaders(observation.requestHeaders),
    })
    while (this.observations.size > MAX_MEDIA_CREDENTIAL_OBSERVATIONS) {
      const oldest = this.observations.keys().next().value
      if (typeof oldest !== 'string') break
      this.observations.delete(oldest)
    }
  }

  get(
    tabId: number,
    pageUrlValue: string,
    urlValue: string
  ): NetworkMediaCredentialObservation | undefined {
    this.prune()
    const pageUrl = httpUrl(pageUrlValue)
    const url = httpUrl(urlValue)
    if (!pageUrl || !url) return undefined
    const observation = this.observations.get(
      observationKey(tabId, pageUrl, url)
    )
    return observation
      ? {
          ...observation,
          requestHeaders: { ...observation.requestHeaders },
        }
      : undefined
  }

  retainPage(tabId: number, pageUrlValue: string): void {
    const pageUrl = httpUrl(pageUrlValue)
    for (const [key, observation] of this.observations) {
      if (
        observation.tabId === tabId &&
        (!pageUrl || observation.pageUrl !== pageUrl)
      ) {
        this.observations.delete(key)
      }
    }
  }

  clear(tabId: number): void {
    for (const [key, observation] of this.observations) {
      if (observation.tabId === tabId) this.observations.delete(key)
    }
  }

  clearAll(): void {
    this.observations.clear()
  }

  private prune(): void {
    const oldestAllowed = this.now() - MEDIA_CREDENTIAL_TTL_MS
    for (const [key, observation] of this.observations) {
      if (observation.observedAt < oldestAllowed) {
        this.observations.delete(key)
      }
    }
  }
}
