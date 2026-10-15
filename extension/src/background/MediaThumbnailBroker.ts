import type { MediaStore } from '@/background/MediaStore'
import { resolveStoredMedia } from '@/background/mediaTrust'
import { extensionBrowser as browser } from '@/shared/browser'
import {
  type DetectedMedia,
  mediaCategory,
  mediaStorageKey,
} from '@/shared/media'

const THUMBNAIL_EDGE = 72
const DEFAULT_TIMEOUT_MS = 1_000
const CACHE_TTL_MS = 60_000
const MAX_CACHE_ITEMS = 64
const MAX_CACHE_BYTES = 512 * 1024
const MAX_DATA_URL_BYTES = 48 * 1024
const MAX_CANDIDATE_FRAMES = 16

interface TabLike {
  id?: number
  url?: string
  active?: boolean
}

export interface MediaThumbnailTabsApi {
  query(info: { active: true; currentWindow: true }): Promise<TabLike[]>
  get(tabId: number): Promise<TabLike>
  sendMessage(
    tabId: number,
    message: unknown,
    options?: { frameId?: number }
  ): Promise<unknown>
}

interface NavigationFrame {
  frameId: number
  url: string
}

export interface MediaThumbnailWebNavigationApi {
  getAllFrames(details: {
    tabId: number
  }): Promise<NavigationFrame[] | null | undefined>
}

interface CacheEntry {
  tabId: number
  dataUrl: string
  bytes: number
  expiresAt: number
}

interface InFlightEntry {
  tabId: number
  promise: Promise<MediaThumbnailResult>
}

export interface MediaThumbnailBrokerOptions {
  store: Pick<MediaStore, 'get'>
  tabs?: MediaThumbnailTabsApi
  webNavigation?: MediaThumbnailWebNavigationApi
  timeoutMs?: number
  now?: () => number
}

export interface MediaThumbnailResult {
  dataUrl: string | null
}

const NO_THUMBNAIL: MediaThumbnailResult = { dataUrl: null }

function activeTabQuery(): { active: true; currentWindow: true } {
  return { active: true, currentWindow: true }
}

function isSafeRasterImage(media: DetectedMedia): boolean {
  if (mediaCategory(media) !== 'image' || media.previewable === false) {
    return false
  }
  const mimeType = media.mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mimeType === 'image/svg+xml') return false
  try {
    return !/\.svgz?$/i.test(new URL(media.url).pathname)
  } catch {
    return false
  }
}

/**
 * Accept only the compact raster data URLs produced by the content-side
 * thumbnail renderer. Keeping the response envelope tiny and strict prevents
 * a compromised page relay from turning the service worker into blob storage.
 */
function validatedDataUrl(response: unknown): string | null {
  if (
    !response ||
    typeof response !== 'object' ||
    !Object.hasOwn(response, 'dataUrl')
  ) {
    return null
  }
  const dataUrl = (response as { dataUrl?: unknown }).dataUrl
  if (
    typeof dataUrl !== 'string' ||
    dataUrl.length === 0 ||
    dataUrl.length > MAX_DATA_URL_BYTES
  ) {
    return null
  }
  const match =
    /^data:image\/(?:webp|png|jpeg);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(
      dataUrl
    )
  return match?.[1] ? dataUrl : null
}

function cacheKey(tabId: number, pageUrl: string, mediaKey: string): string {
  return JSON.stringify([tabId, pageUrl, mediaKey])
}

/**
 * Trusted bridge between Popup selections and a page-frame thumbnail renderer.
 * The broker never accepts a raw resource URL from Popup: it resolves a stable
 * key through MediaStore, authenticates the active tab, and returns only a
 * small validated raster data URL.
 */
export class MediaThumbnailBroker {
  private readonly store: Pick<MediaStore, 'get'>
  private readonly tabs: MediaThumbnailTabsApi
  private readonly webNavigation: MediaThumbnailWebNavigationApi
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, InFlightEntry>()
  private readonly generationByTab = new Map<number, number>()
  private readonly pendingByTab = new Map<number, number>()
  private cacheBytes = 0

  constructor(options: MediaThumbnailBrokerOptions) {
    this.store = options.store
    this.tabs =
      options.tabs ?? (browser.tabs as unknown as MediaThumbnailTabsApi)
    this.webNavigation =
      options.webNavigation ??
      (browser.webNavigation as unknown as MediaThumbnailWebNavigationApi)
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.now = options.now ?? Date.now
  }

  async get(mediaKey: unknown): Promise<MediaThumbnailResult> {
    try {
      const [initialTab] = await this.tabs.query(activeTabQuery())
      if (typeof initialTab?.id !== 'number' || !initialTab.url) {
        return NO_THUMBNAIL
      }

      const media = await resolveStoredMedia(
        mediaKey,
        async () => initialTab,
        this.store
      )
      if (!isSafeRasterImage(media)) return NO_THUMBNAIL

      const tabId = initialTab.id
      const pageUrl = initialTab.url
      if (!(await this.contextIsCurrent(tabId, pageUrl))) {
        return NO_THUMBNAIL
      }

      const key = cacheKey(tabId, pageUrl, mediaStorageKey(media))
      const cached = this.readCache(key)
      if (cached) return { dataUrl: cached }

      const pending = this.inFlight.get(key)
      if (pending) return await pending.promise

      const generation = this.generationByTab.get(tabId) ?? 0
      this.pendingByTab.set(tabId, (this.pendingByTab.get(tabId) ?? 0) + 1)
      const promise = this.loadThumbnail(tabId, pageUrl, media, key, generation)
      this.inFlight.set(key, { tabId, promise })
      try {
        return await promise
      } finally {
        if (this.inFlight.get(key)?.promise === promise) {
          this.inFlight.delete(key)
        }
        const pending = (this.pendingByTab.get(tabId) ?? 1) - 1
        if (pending > 0) this.pendingByTab.set(tabId, pending)
        else {
          this.pendingByTab.delete(tabId)
          this.generationByTab.delete(tabId)
        }
      }
    } catch {
      // A content script can disappear at any point during navigation. Keep
      // failures opaque so neither its URL nor page-controlled error text is
      // reflected to Popup.
      return NO_THUMBNAIL
    }
  }

  clear(tabId: number): void {
    this.generationByTab.set(tabId, (this.generationByTab.get(tabId) ?? 0) + 1)
    for (const [key, entry] of this.cache) {
      if (entry.tabId === tabId) this.deleteCacheEntry(key, entry)
    }
    for (const [key, entry] of this.inFlight) {
      if (entry.tabId === tabId) this.inFlight.delete(key)
    }
    if (!this.pendingByTab.has(tabId)) this.generationByTab.delete(tabId)
  }

  private async loadThumbnail(
    tabId: number,
    pageUrl: string,
    media: DetectedMedia,
    key: string,
    generation: number
  ): Promise<MediaThumbnailResult> {
    const frameIds = await this.candidateFrames(tabId, media.frameUrl)
    if (frameIds.length === 0) return NO_THUMBNAIL

    const deadline = this.now() + this.timeoutMs
    for (const frameId of frameIds) {
      const remainingMs = Math.max(0, deadline - this.now())
      if (remainingMs === 0) break
      const response = await this.sendWithTimeout(
        tabId,
        frameId,
        media.url,
        remainingMs
      )
      const dataUrl = validatedDataUrl(response)
      if (!dataUrl) continue

      if (
        (this.generationByTab.get(tabId) ?? 0) !== generation ||
        !(await this.contextIsCurrent(tabId, pageUrl))
      ) {
        return NO_THUMBNAIL
      }
      this.writeCache(key, tabId, dataUrl)
      return { dataUrl }
    }
    return NO_THUMBNAIL
  }

  private async candidateFrames(
    tabId: number,
    frameUrl: string | undefined
  ): Promise<number[]> {
    if (!frameUrl) return [0]
    let frames: NavigationFrame[] | null | undefined
    try {
      frames = await this.webNavigation.getAllFrames({ tabId })
    } catch {
      return []
    }
    const seen = new Set<number>()
    const matches: number[] = []
    for (const frame of frames ?? []) {
      if (
        frame.url !== frameUrl ||
        !Number.isSafeInteger(frame.frameId) ||
        frame.frameId < 0 ||
        seen.has(frame.frameId)
      ) {
        continue
      }
      seen.add(frame.frameId)
      matches.push(frame.frameId)
      if (matches.length >= MAX_CANDIDATE_FRAMES) break
    }
    return matches.sort((left, right) => left - right)
  }

  private async sendWithTimeout(
    tabId: number,
    frameId: number,
    url: string,
    timeoutMs: number
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          this.tabs.sendMessage(
            tabId,
            {
              kind: 'content.imageThumbnail',
              payload: { url, maxEdge: THUMBNAIL_EDGE },
            },
            { frameId }
          )
        ),
        timeout,
      ])
    } catch {
      return null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async contextIsCurrent(
    tabId: number,
    pageUrl: string
  ): Promise<boolean> {
    try {
      const [activeTabs, currentTab] = await Promise.all([
        this.tabs.query(activeTabQuery()),
        this.tabs.get(tabId),
      ])
      const activeTab = activeTabs[0]
      return (
        activeTab?.id === tabId &&
        activeTab.url === pageUrl &&
        currentTab.id === tabId &&
        currentTab.url === pageUrl &&
        currentTab.active !== false
      )
    } catch {
      return false
    }
  }

  private readCache(key: string): string | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.deleteCacheEntry(key, entry)
      return null
    }
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.dataUrl
  }

  private writeCache(key: string, tabId: number, dataUrl: string): void {
    const previous = this.cache.get(key)
    if (previous) this.deleteCacheEntry(key, previous)
    const entry: CacheEntry = {
      tabId,
      dataUrl,
      bytes: dataUrl.length,
      expiresAt: this.now() + CACHE_TTL_MS,
    }
    this.cache.set(key, entry)
    this.cacheBytes += entry.bytes
    this.pruneCache()
  }

  private pruneCache(): void {
    const now = this.now()
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.deleteCacheEntry(key, entry)
    }
    while (
      this.cache.size > MAX_CACHE_ITEMS ||
      this.cacheBytes > MAX_CACHE_BYTES
    ) {
      const oldest = this.cache.entries().next().value as
        | [string, CacheEntry]
        | undefined
      if (!oldest) break
      this.deleteCacheEntry(oldest[0], oldest[1])
    }
  }

  private deleteCacheEntry(key: string, entry: CacheEntry): void {
    if (this.cache.get(key) !== entry) return
    this.cache.delete(key)
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.bytes)
  }
}
