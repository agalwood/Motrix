import { extensionBrowser } from '@/shared/browser'
import {
  type DetectedMedia,
  mediaCategory,
  mediaStorageKey,
  mediaTabStorageKey,
} from '@/shared/media'

export const MAX_MEDIA_PER_TAB = 200
export const MAX_IMAGE_MEDIA_PER_TAB = 120
export const MAX_MEDIA_STORAGE_BYTES_PER_TAB = 256 * 1024

const KIND_PRIORITY: Readonly<Record<DetectedMedia['kind'], number>> = {
  direct: 0,
  dash: 1,
  hls: 1,
  mux: 2,
}

function isMeaningful(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? ''
}

function observationRichness(media: DetectedMedia): number {
  return Object.values(media).reduce((score, value) => {
    if (!isMeaningful(value)) return score
    if (Array.isArray(value)) return score + value.length
    if (typeof value === 'object') return score + Object.keys(value).length
    return score + 1
  }, 0)
}

function prefersIncoming(
  existing: DetectedMedia,
  incoming: DetectedMedia
): boolean {
  if (incoming.detectedAt !== existing.detectedAt) {
    return incoming.detectedAt > existing.detectedAt
  }
  const richnessDifference =
    observationRichness(incoming) - observationRichness(existing)
  if (richnessDifference !== 0) return richnessDifference > 0
  return canonicalJson(incoming) > canonicalJson(existing)
}

function meaningfulFields(media: DetectedMedia): Partial<DetectedMedia> {
  return Object.fromEntries(
    Object.entries(media).filter(([, value]) => isMeaningful(value))
  ) as Partial<DetectedMedia>
}

/** Request context is credential material and belongs only in the in-memory
 * MediaCredentialStore. Strip legacy/new fields at the storage boundary so a
 * Popup scan or storage.onChanged event can never receive them. */
function publicMediaRecord(media: DetectedMedia): DetectedMedia {
  const { requestHeaders: _privateRequestHeaders, ...record } =
    media as DetectedMedia & { requestHeaders?: Record<string, string> }
  return record
}

function positiveMaximum(
  left: number | undefined,
  right: number | undefined
): number | undefined {
  const candidates = [left, right].filter(
    (value): value is number => Number.isFinite(value) && (value ?? 0) > 0
  )
  return candidates.length > 0 ? Math.max(...candidates) : undefined
}

function evidenceBackedText(
  existing: DetectedMedia,
  incoming: DetectedMedia,
  field: 'mimeType' | 'suggestedFilename',
  evidence: string,
  preferred: DetectedMedia,
  fallback: DetectedMedia
): string | undefined {
  const existingValue = existing[field]?.trim()
  const incomingValue = incoming[field]?.trim()
  const existingBacked =
    Boolean(existingValue) && existing.evidence?.includes(evidence) === true
  const incomingBacked =
    Boolean(incomingValue) && incoming.evidence?.includes(evidence) === true
  if (existingBacked !== incomingBacked) {
    return existingBacked ? existingValue : incomingValue
  }
  return preferred[field]?.trim() || fallback[field]?.trim() || undefined
}

/**
 * Combine observations without allowing a sparse refresh to erase metadata
 * learned from another capture source. Conflicts prefer the newest observation;
 * equal timestamps use richness and a canonical value as stable tie-breakers.
 */
function mergeMedia(
  existing: DetectedMedia,
  incoming: DetectedMedia
): DetectedMedia {
  const incomingPreferred = prefersIncoming(existing, incoming)
  const preferred = incomingPreferred ? incoming : existing
  const fallback = incomingPreferred ? existing : incoming
  const merged = {
    ...meaningfulFields(fallback),
    ...meaningfulFields(preferred),
    url: existing.url,
    detectedAt: Math.max(existing.detectedAt, incoming.detectedAt),
  } as DetectedMedia

  merged.kind =
    KIND_PRIORITY[existing.kind] > KIND_PRIORITY[incoming.kind]
      ? existing.kind
      : KIND_PRIORITY[incoming.kind] > KIND_PRIORITY[existing.kind]
        ? incoming.kind
        : preferred.kind
  if (merged.kind !== 'direct') merged.category = 'video'

  const evidence = [
    ...new Set([...(existing.evidence ?? []), ...(incoming.evidence ?? [])]),
  ]
    .filter((item) => item.trim().length > 0)
    .sort()
  if (evidence.length > 0) merged.evidence = evidence

  const suggestedFilename = evidenceBackedText(
    existing,
    incoming,
    'suggestedFilename',
    'content-disposition',
    preferred,
    fallback
  )
  const mimeType = evidenceBackedText(
    existing,
    incoming,
    'mimeType',
    'content-type',
    preferred,
    fallback
  )
  if (suggestedFilename) merged.suggestedFilename = suggestedFilename
  else delete merged.suggestedFilename
  if (mimeType) merged.mimeType = mimeType
  else delete merged.mimeType

  const sizeBytes = positiveMaximum(existing.sizeBytes, incoming.sizeBytes)
  const width = positiveMaximum(existing.width, incoming.width)
  const height = positiveMaximum(existing.height, incoming.height)
  if (sizeBytes !== undefined) merged.sizeBytes = sizeBytes
  else delete merged.sizeBytes
  if (width !== undefined) merged.width = width
  else delete merged.width
  if (height !== undefined) merged.height = height
  else delete merged.height
  if (existing.previewable === false || incoming.previewable === false) {
    merged.previewable = false
  } else if (existing.previewable === true || incoming.previewable === true) {
    merged.previewable = true
  }
  return merged
}

function detectedAtValue(media: DetectedMedia): number {
  return Number.isFinite(media.detectedAt) ? media.detectedAt : 0
}

function imageRetentionScore(media: DetectedMedia): number {
  const width = positiveMaximum(media.width, undefined) ?? 0
  const height = positiveMaximum(media.height, undefined) ?? 0
  const sizeBytes = positiveMaximum(media.sizeBytes, undefined) ?? 0
  let score = Math.log2(width * height + 1) * 10
  score += Math.log2(sizeBytes + 1) * 2

  for (const rawEvidence of new Set(media.evidence ?? [])) {
    const evidence = rawEvidence.toLowerCase()
    if (evidence.includes('current-src') || evidence.includes('currentsrc')) {
      score += 80
    } else if (evidence === 'poster' || evidence === 'meta') {
      score += 35
    } else if (evidence === 'picture' || evidence === 'srcset') {
      score += 25
    } else if (
      evidence === 'img' ||
      evidence === 'link' ||
      evidence === 'input-image'
    ) {
      score += 12
    } else if (evidence === 'network') {
      score += 4
    } else {
      score += 2
    }
  }
  if (media.previewable === true) score += 4
  if (media.suggestedFilename) score += 2
  if (media.alt) score += 2
  return score
}

function oldestMediaKey(
  items: ReadonlyMap<string, DetectedMedia>,
  matches: (media: DetectedMedia) => boolean
): string | undefined {
  let oldestKey: string | undefined
  let oldestDetectedAt = Number.POSITIVE_INFINITY
  for (const [key, media] of items) {
    if (!matches(media)) continue
    const detectedAt = detectedAtValue(media)
    if (oldestKey === undefined || detectedAt < oldestDetectedAt) {
      oldestKey = key
      oldestDetectedAt = detectedAt
    }
  }
  return oldestKey
}

function leastValuableImageKey(
  items: ReadonlyMap<string, DetectedMedia>
): string | undefined {
  let selectedKey: string | undefined
  let selectedScore = Number.POSITIVE_INFINITY
  let selectedDetectedAt = Number.POSITIVE_INFINITY
  for (const [key, media] of items) {
    if (mediaCategory(media) !== 'image') continue
    const score = imageRetentionScore(media)
    const detectedAt = detectedAtValue(media)
    if (
      selectedKey === undefined ||
      score < selectedScore ||
      (score === selectedScore && detectedAt < selectedDetectedAt)
    ) {
      selectedKey = key
      selectedScore = score
      selectedDetectedAt = detectedAt
    }
  }
  return selectedKey
}

function serializedMediaBytes(items: Iterable<DetectedMedia>): number {
  return new TextEncoder().encode(JSON.stringify([...items])).byteLength
}

function isStorageQuotaError(error: unknown): boolean {
  return /quota|quota_bytes/i.test(
    error instanceof Error ? error.message : String(error)
  )
}

interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

function resolveSessionStorage(): SessionStorageArea {
  const storage = extensionBrowser.storage?.session
  if (!storage) throw new Error('session storage is unavailable')
  return storage
}

export class MediaStore {
  private readonly operationTails = new Map<number, Promise<void>>()
  private readonly currentPageByTab = new Map<number, string | null>()
  private readonly storage = resolveSessionStorage()

  async add(tabId: number, items: DetectedMedia[]): Promise<void> {
    return this.enqueue(tabId, async () => {
      const existing = await this.read(tabId)
      await this.writeMerged(tabId, existing, items)
    })
  }

  /**
   * Atomically discard findings from prior navigations and add findings for
   * the current page. Keeping both steps in one per-tab queue operation avoids
   * a late network response being inserted between retainPage() and add().
   */
  async addForPage(
    tabId: number,
    pageUrl: string,
    items: DetectedMedia[]
  ): Promise<void> {
    return this.enqueue(tabId, async () => {
      if (
        this.currentPageByTab.has(tabId) &&
        this.currentPageByTab.get(tabId) !== pageUrl
      ) {
        return
      }
      const existing = (await this.read(tabId)).filter(
        (media) => media.pageUrl === pageUrl
      )
      const currentItems = items.filter((media) => media.pageUrl === pageUrl)
      await this.writeMerged(tabId, existing, currentItems)
    })
  }

  async get(tabId: number): Promise<DetectedMedia[]> {
    return this.enqueue(tabId, () => this.read(tabId))
  }

  async clear(tabId: number): Promise<void> {
    this.currentPageByTab.set(tabId, null)
    return this.enqueue(tabId, async () => {
      await this.storage.remove(mediaTabStorageKey(tabId))
    })
  }

  /**
   * Keep same-page results so a repeat scan can return the already-installed
   * sniffer's findings, while dropping media left behind by tab navigation.
   */
  async retainPage(tabId: number, pageUrl: string): Promise<void> {
    this.currentPageByTab.set(tabId, pageUrl)
    return this.enqueue(tabId, async () => {
      const current = await this.read(tabId)
      const retained = current.filter((media) => media.pageUrl === pageUrl)
      if (retained.length === current.length) return
      if (retained.length === 0) {
        await this.storage.remove(mediaTabStorageKey(tabId))
        return
      }
      await this.storage.set({ [mediaTabStorageKey(tabId)]: retained })
    })
  }

  private async read(tabId: number): Promise<DetectedMedia[]> {
    const key = mediaTabStorageKey(tabId)
    const r = await this.storage.get(key)
    const records = (r[key] as DetectedMedia[] | undefined) ?? []
    return records.map(publicMediaRecord)
  }

  private async writeMerged(
    tabId: number,
    existing: DetectedMedia[],
    items: DetectedMedia[]
  ): Promise<void> {
    const byKey = new Map(
      existing.map((media) => {
        const record = publicMediaRecord(media)
        return [mediaStorageKey(record), record]
      })
    )
    // Refreshing a key moves it to the newest end of the insertion-ordered map,
    // while merging preserves metadata gathered by DOM and network sources.
    for (const rawMedia of items) {
      const media = publicMediaRecord(rawMedia)
      const key = mediaStorageKey(media)
      const previous = byKey.get(key)
      byKey.delete(key)
      byKey.set(key, previous ? mergeMedia(previous, media) : media)
    }

    let imageCount = [...byKey.values()].filter(
      (media) => mediaCategory(media) === 'image'
    ).length
    while (imageCount > MAX_IMAGE_MEDIA_PER_TAB) {
      const imageKey = leastValuableImageKey(byKey)
      if (imageKey === undefined) break
      byKey.delete(imageKey)
      imageCount -= 1
    }

    // The total remains bounded, but low-value images are always the first
    // eviction candidates. A page full of thumbnails therefore cannot displace
    // an HLS, DASH, mux, video or audio observation already stored for the tab.
    while (byKey.size > MAX_MEDIA_PER_TAB) {
      const oldestKey =
        leastValuableImageKey(byKey) ?? oldestMediaKey(byKey, () => true)
      if (oldestKey === undefined) break
      byKey.delete(oldestKey)
    }
    while (
      byKey.size > 0 &&
      serializedMediaBytes(byKey.values()) > MAX_MEDIA_STORAGE_BYTES_PER_TAB
    ) {
      const evictionKey =
        leastValuableImageKey(byKey) ?? oldestMediaKey(byKey, () => true)
      if (evictionKey === undefined) break
      byKey.delete(evictionKey)
    }
    if (byKey.size === 0) {
      await this.storage.remove(mediaTabStorageKey(tabId))
      return
    }
    const key = mediaTabStorageKey(tabId)
    try {
      await this.storage.set({ [key]: [...byKey.values()] })
    } catch (error) {
      if (!isStorageQuotaError(error)) throw error
      // The session quota is shared across tabs. Free this recoverable cache,
      // then retry once with a half-budget snapshot instead of failing every
      // subsequent discovery event while the extension remains open.
      await this.storage.remove(key)
      while (
        byKey.size > 0 &&
        serializedMediaBytes(byKey.values()) >
          MAX_MEDIA_STORAGE_BYTES_PER_TAB / 2
      ) {
        const evictionKey =
          leastValuableImageKey(byKey) ?? oldestMediaKey(byKey, () => true)
        if (evictionKey === undefined) break
        byKey.delete(evictionKey)
      }
      if (byKey.size === 0) return
      try {
        await this.storage.set({ [key]: [...byKey.values()] })
      } catch (retryError) {
        if (!isStorageQuotaError(retryError)) throw retryError
        // Media discovery is a cache. Leaving this tab empty is safer than
        // putting the service worker into a permanent quota failure loop.
      }
    }
  }

  private enqueue<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(tabId) ?? Promise.resolve()
    const result = previous.then(operation)
    const next = result.then(
      () => undefined,
      () => undefined
    )
    this.operationTails.set(tabId, next)
    void next.then(() => {
      if (this.operationTails.get(tabId) === next) {
        this.operationTails.delete(tabId)
      }
    })
    return result
  }
}
