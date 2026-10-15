// MAIN-world YouTube sniffer — observes signed googlevideo.com/videoplayback
// requests, reads window.ytInitialPlayerResponse for itagInfo, and calls
// selectMuxStreams to emit a mux DetectedMedia when a valid pair is found.
//
// This module is designed to run in the MAIN world (injected via chrome.scripting
// executeScript with world:'MAIN'). It has no access to chrome.runtime.
// Results are posted via window.postMessage so the ISOLATED-world sniffer-relay
// can forward them to the background.

import {
  buildYoutubeMux,
  playerResponseToItagInfo,
} from '@/content/youtube/buildYoutubeMux'
import {
  type ObservedStream,
  parseItag,
  selectMuxStreams,
} from '@/content/youtube/extractStreams'
import type { DetectedMedia } from '@/shared/media'

export interface YoutubeSnifferPageContext {
  pageUrl: string
  pageTitle: string
}

export interface YoutubeSnifferHandle {
  scan: (ctx?: YoutubeSnifferPageContext) => void
  uninstall: () => void
  /** Lightweight diagnostics used to verify long-lived SPA cache bounds. */
  cacheSizes: () => {
    observed: number
    reported: number
    resourcePages: number
  }
}

const MAX_OBSERVED_STREAMS = 256
const MAX_REPORTED_PAIRS = 256
const MAX_RESOURCE_KEYS = 4_096
const MAX_PERFORMANCE_ENTRIES = 5_000
const MAX_PLAYER_FORMATS = 256
const MAX_STREAM_URL_LENGTH = 16 * 1024

class BoundedLruMap<K, V> {
  readonly #values = new Map<K, V>()

  constructor(readonly maxSize: number) {}

  get size(): number {
    return this.#values.size
  }

  clear(): void {
    this.#values.clear()
  }

  get(key: K): V | undefined {
    const value = this.#values.get(key)
    if (value === undefined) return undefined
    this.#values.delete(key)
    this.#values.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.#values.delete(key)
    this.#values.set(key, value)
    while (this.#values.size > this.maxSize) {
      const oldest = this.#values.keys().next().value
      if (oldest === undefined) break
      this.#values.delete(oldest)
    }
  }

  values(): IterableIterator<V> {
    return this.#values.values()
  }
}

class BoundedLruSet<T> {
  readonly #values: BoundedLruMap<T, true>

  constructor(maxSize: number) {
    this.#values = new BoundedLruMap(maxSize)
  }

  get size(): number {
    return this.#values.size
  }

  clear(): void {
    this.#values.clear()
  }

  has(value: T): boolean {
    return this.#values.get(value) === true
  }

  add(value: T): void {
    this.#values.set(value, true)
  }
}

const resourceKey = (entry: PerformanceEntry, name: string): string => {
  const resource = entry as PerformanceResourceTiming
  return [
    name,
    resource.startTime,
    resource.duration,
    resource.initiatorType,
  ].join('\n')
}

function isGooglevideoPlayback(value: string): boolean {
  if (value.length === 0 || value.length > MAX_STREAM_URL_LENGTH) return false
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      (hostname === 'googlevideo.com' ||
        hostname.endsWith('.googlevideo.com')) &&
      parsed.pathname === '/videoplayback'
    )
  } catch {
    return false
  }
}

/**
 * Collect itagInfo from window.ytInitialPlayerResponse if available.
 * Returns undefined if the player response isn't present or has no adaptiveFormats.
 */
function readItagInfoFromPlayerResponse():
  | ReturnType<typeof playerResponseToItagInfo>
  | undefined {
  try {
    const w = window as unknown as {
      ytInitialPlayerResponse?: {
        streamingData?: { adaptiveFormats?: unknown[] }
      }
    }
    const formats = w.ytInitialPlayerResponse?.streamingData?.adaptiveFormats
    if (!Array.isArray(formats) || formats.length === 0) return undefined
    return playerResponseToItagInfo(formats.slice(0, MAX_PLAYER_FORMATS))
  } catch {
    return undefined
  }
}

/**
 * Install the YouTube adaptive-stream sniffer in the MAIN world.
 *
 * @param report  Callback invoked with a single DetectedMedia when a mux pair
 *                is found. The callback is idempotent — duplicate pairs produce
 *                duplicate calls.
 * @param initialCtx Page context captured at first injection.
 */
// I-2: helper to derive the request URL from the fetch input argument.
const inputUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url

export function installYoutubeSniffer(
  report: (m: DetectedMedia) => void,
  initialCtx: YoutubeSnifferPageContext,
  resolveContext?: () => YoutubeSnifferPageContext
): YoutubeSnifferHandle {
  let active = true
  const observed = new BoundedLruMap<number, ObservedStream>(
    MAX_OBSERVED_STREAMS
  )
  // I-3: dedup at the report boundary — one emission per unique video+audio pair.
  const reported = new BoundedLruSet<string>(MAX_REPORTED_PAIRS)
  const resourcePageByKey = new BoundedLruMap<string, string>(MAX_RESOURCE_KEYS)
  const resourcePageByEntry = new WeakMap<PerformanceEntry, string>()
  let currentCtx = initialCtx

  const getCurrentContext = (): YoutubeSnifferPageContext => {
    try {
      return resolveContext?.() ?? currentCtx
    } catch {
      return currentCtx
    }
  }

  const syncRoute = (): void => {
    if (!active) return
    const nextCtx = getCurrentContext()
    if (nextCtx.pageUrl === currentCtx.pageUrl) {
      currentCtx = nextCtx
      return
    }
    currentCtx = nextCtx
    observed.clear()
    reported.clear()
    resourcePageByKey.clear()
  }

  const tryEmit = (): void => {
    if (!active) return
    try {
      const itagInfo = readItagInfoFromPlayerResponse()
      const result = selectMuxStreams([...observed.values()], itagInfo)
      if (!result) return
      const key = `${result.video}\n${result.audio}`
      if (reported.has(key)) return
      reported.add(key)
      report(
        buildYoutubeMux(result, {
          pageUrl: currentCtx.pageUrl,
          pageTitle: currentCtx.pageTitle,
          now: Date.now(),
        })
      )
    } catch {
      // Reporting and page-owned metadata are observational only.
    }
  }

  const observe = (url: string): void => {
    if (!active) return
    syncRoute()
    if (!isGooglevideoPlayback(url)) return
    const itag = parseItag(url)
    if (itag === null) return
    observed.set(itag, { url, itag })
    tryEmit()
  }

  // 1. Patch fetch to observe future googlevideo requests.
  // I-2: observe the REQUEST URL (args[0]) not the response URL, so that
  //       itag query params on the original URL are preserved through redirects.
  const origFetch = window.fetch
  const wrappedFetch: typeof window.fetch = function (
    this: typeof window,
    ...args
  ) {
    const result = Reflect.apply(origFetch, this, args)
    try {
      if (active) observe(inputUrl(args[0]))
    } catch {
      // Hostile Request getters cannot change fetch behavior.
    }
    return result
  }
  window.fetch = wrappedFetch

  // 2. Patch XHR to observe future googlevideo requests.
  const origOpen = XMLHttpRequest.prototype.open
  const xhrUrls = new WeakMap<XMLHttpRequest, string>()
  const observedXhrs = new WeakSet<XMLHttpRequest>()
  const wrappedOpen: typeof XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    // biome-ignore lint/suspicious/noExplicitAny: XHR open signature passthrough
    ...rest: any[]
  ) {
    const result = Reflect.apply(origOpen, this, [method, url, ...rest])
    try {
      if (!active) return result
      xhrUrls.set(this, String(url))
      if (!observedXhrs.has(this)) {
        this.addEventListener('load', () => {
          if (!active) return
          try {
            const requestUrl = xhrUrls.get(this)
            if (requestUrl) observe(requestUrl)
          } catch {
            // Page-owned EventTarget/getters are observational only.
          }
        })
        observedXhrs.add(this)
      }
    } catch {
      // addEventListener or URL coercion failure cannot change open behavior.
    }
    return result
  } as typeof XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = wrappedOpen

  const rememberResourceOwner = (
    entry: PerformanceEntry,
    key: string,
    pageUrl: string
  ): void => {
    resourcePageByEntry.set(entry, pageUrl)
    resourcePageByKey.set(key, pageUrl)
  }

  const resourceOwner = (
    entry: PerformanceEntry,
    key: string
  ): string | undefined => {
    const owner = resourcePageByEntry.get(entry) ?? resourcePageByKey.get(key)
    if (owner !== undefined) rememberResourceOwner(entry, key, owner)
    return owner
  }

  const scan = (
    nextCtx: YoutubeSnifferPageContext = getCurrentContext()
  ): void => {
    if (!active) return
    const pageChanged = nextCtx.pageUrl !== currentCtx.pageUrl
    currentCtx = nextCtx
    observed.clear()
    reported.clear()
    if (pageChanged) resourcePageByKey.clear()

    // Harvest already-loaded googlevideo URLs from Resource Timing. Like the
    // generic sniffer, avoid relabelling entries already consumed on a prior SPA
    // route while allowing a same-route rescan to reconstruct the cache.
    try {
      const entries = performance
        .getEntriesByType('resource')
        .slice(-MAX_PERFORMANCE_ENTRIES)
      for (const entry of entries) {
        try {
          const name = (entry as PerformanceResourceTiming).name
          if (typeof name !== 'string' || !isGooglevideoPlayback(name)) continue
          const key = resourceKey(entry, name)
          const owningPage = resourceOwner(entry, key)
          if (owningPage === undefined) {
            rememberResourceOwner(entry, key, nextCtx.pageUrl)
          } else if (owningPage !== nextCtx.pageUrl) {
            continue
          }
          observe(name)
        } catch {
          // One hostile PerformanceEntry must not abort the remaining scan.
        }
      }
    } catch {
      /* Resource Timing API unavailable — live hooks still apply */
    }
  }

  scan(initialCtx)

  return {
    scan,
    cacheSizes: () => ({
      observed: observed.size,
      reported: reported.size,
      resourcePages: resourcePageByKey.size,
    }),
    uninstall: () => {
      if (!active) return
      active = false
      observed.clear()
      reported.clear()
      resourcePageByKey.clear()
      if (window.fetch === wrappedFetch) window.fetch = origFetch
      if (XMLHttpRequest.prototype.open === wrappedOpen) {
        XMLHttpRequest.prototype.open = origOpen
      }
    },
  }
}
