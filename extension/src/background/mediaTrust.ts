import {
  type DetectedMedia,
  inferMediaMimeType,
  mediaCategory,
  mediaStorageKey,
} from '@/shared/media'

const MAX_REPORT_ITEMS = 100
const MAX_URL_LENGTH = 32_768
const MAX_TITLE_LENGTH = 512
const MAX_MIME_LENGTH = 256
const MAX_ALT_LENGTH = 512
const MAX_FILENAME_LENGTH = 255
const MAX_DIMENSION = 100_000
const MAX_EVIDENCE_ITEMS = 8
const MAX_REPORT_TEXT_UNITS = 128 * 1024
const MEDIA_KINDS = new Set<DetectedMedia['kind']>([
  'hls',
  'dash',
  'direct',
  'mux',
])
const MEDIA_EVIDENCE = new Set([
  'img',
  'picture',
  'source',
  'video',
  'audio',
  'poster',
  'srcset',
  'current-src',
  'lazy',
  'css-background',
  'css-pseudo',
  'meta',
  'link',
  'input-image',
  'performance',
  'fetch',
  'xhr',
  'body-hls',
  'body-dash',
  'body-json',
])

interface MediaStoreReader {
  get(tabId: number): Promise<DetectedMedia[]>
}

interface ActiveTab {
  id?: number | undefined
  url?: string | undefined
}

function httpUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH
  ) {
    return null
  }
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null
  } catch {
    return null
  }
}

function documentUrlKey(value: unknown): string | null {
  const normalized = httpUrl(value)
  if (!normalized) return null
  const parsed = new URL(normalized)
  parsed.hash = ''
  return parsed.toString()
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

/** Generic page messages cannot mint arbitrary hidden secondary requests.
 * The only page-world mux producer today is the dedicated YouTube resolver;
 * constrain that seam to the expected page and media origins. */
function isTrustedPageMux(
  pageUrlValue: string,
  videoUrlValue: string,
  audioUrlValue: string
): boolean {
  try {
    const pageUrl = new URL(pageUrlValue)
    const videoUrl = new URL(videoUrlValue)
    const audioUrl = new URL(audioUrlValue)
    const youtubePage =
      hostMatches(pageUrl.hostname, 'youtube.com') ||
      hostMatches(pageUrl.hostname, 'youtube-nocookie.com') ||
      pageUrl.hostname === 'youtu.be'
    return (
      youtubePage &&
      videoUrl.protocol === 'https:' &&
      audioUrl.protocol === 'https:' &&
      hostMatches(videoUrl.hostname, 'googlevideo.com') &&
      hostMatches(audioUrl.hostname, 'googlevideo.com')
    )
  } catch {
    return false
  }
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: page-controlled control characters are intentionally removed
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
    ? value
    : undefined
}

function suggestedFilename(value: unknown): string | undefined {
  const text = boundedText(value, MAX_FILENAME_LENGTH)
  if (!text) return undefined
  // A page may suggest a leaf name, never a native path. The submission layer
  // sanitizes once more before the value reaches Motrix.
  const leaf = text.split(/[\\/]/).at(-1)?.trim()
  return leaf || undefined
}

function normalizedEvidence(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && MEDIA_EVIDENCE.has(entry)
      )
    ),
  ].slice(0, MAX_EVIDENCE_ITEMS)
  return result.length > 0 ? result : undefined
}

function reportItemTextUnits(item: Record<string, unknown>): number {
  let units = 0
  for (const field of [
    'kind',
    'url',
    'audioUrl',
    'pageUrl',
    'pageTitle',
    'mimeType',
    'category',
    'suggestedFilename',
    'alt',
  ]) {
    const value = item[field]
    if (typeof value === 'string') units += value.length
  }
  if (Array.isArray(item.evidence)) {
    for (const value of item.evidence.slice(0, MAX_EVIDENCE_ITEMS)) {
      if (typeof value === 'string') units += value.length
    }
  }
  return units
}

/**
 * Treat MAIN-world reports as page-controlled input. Only accept bounded,
 * HTTP(S) records that belong to the browser-authenticated sender tab.
 */
export function normalizeMediaReport(
  payload: unknown,
  senderTabUrl: string,
  detectedAt = Date.now()
): DetectedMedia[] {
  const trustedPageUrl = httpUrl(senderTabUrl)
  const trustedDocumentKey = documentUrlKey(senderTabUrl)
  if (!trustedPageUrl || typeof payload !== 'object' || payload === null) {
    return []
  }
  const report = payload as { tabUrl?: unknown; items?: unknown }
  if (
    documentUrlKey(report.tabUrl) !== trustedDocumentKey ||
    !Array.isArray(report.items)
  ) {
    return []
  }

  const normalized: DetectedMedia[] = []
  let reportTextUnits = 0
  for (const raw of report.items.slice(0, MAX_REPORT_ITEMS)) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    reportTextUnits += reportItemTextUnits(item)
    if (reportTextUnits > MAX_REPORT_TEXT_UNITS) break
    const kind = item.kind
    const url = httpUrl(item.url)
    if (
      typeof kind !== 'string' ||
      !MEDIA_KINDS.has(kind as DetectedMedia['kind']) ||
      !url ||
      documentUrlKey(item.pageUrl) !== trustedDocumentKey ||
      typeof item.pageTitle !== 'string'
    ) {
      continue
    }

    const mediaKind = kind as DetectedMedia['kind']
    const audioUrl = mediaKind === 'mux' ? httpUrl(item.audioUrl) : null
    if (mediaKind === 'mux' && !audioUrl) continue
    if (
      mediaKind === 'mux' &&
      audioUrl &&
      !isTrustedPageMux(trustedPageUrl, url, audioUrl)
    ) {
      continue
    }
    const mimeType = boundedText(item.mimeType, MAX_MIME_LENGTH)
    const inferredMimeType = inferMediaMimeType(url, mimeType) ?? undefined
    const category = mediaCategory({
      kind: mediaKind,
      url,
      ...(inferredMimeType ? { mimeType: inferredMimeType } : {}),
    })
    const width = positiveInteger(item.width, MAX_DIMENSION)
    const height = positiveInteger(item.height, MAX_DIMENSION)
    const sizeBytes = positiveInteger(item.sizeBytes, Number.MAX_SAFE_INTEGER)
    const alt = boundedText(item.alt, MAX_ALT_LENGTH)
    const filename = suggestedFilename(item.suggestedFilename)
    const evidence = normalizedEvidence(item.evidence)
    const previewable =
      category === 'image'
        ? inferredMimeType?.split(';', 1)[0]?.trim().toLowerCase() !==
            'image/svg+xml' && !/\.svgz?(?:$|[?#])/i.test(url)
        : undefined

    normalized.push({
      kind: mediaKind,
      url,
      pageUrl: trustedPageUrl,
      pageTitle:
        boundedText(item.pageTitle, MAX_TITLE_LENGTH) ?? trustedPageUrl,
      detectedAt,
      category,
      ...(inferredMimeType ? { mimeType: inferredMimeType } : {}),
      ...(audioUrl ? { audioUrl } : {}),
      ...(filename ? { suggestedFilename: filename } : {}),
      ...(sizeBytes ? { sizeBytes } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(alt ? { alt } : {}),
      ...(previewable !== undefined ? { previewable } : {}),
      ...(evidence ? { evidence } : {}),
    })
  }
  return normalized
}

/** Resolve a popup selection back to the canonical record held by background. */
export async function resolveStoredMedia(
  requestedKey: unknown,
  queryActiveTab: () => Promise<ActiveTab | undefined>,
  store: MediaStoreReader
): Promise<DetectedMedia> {
  if (
    typeof requestedKey !== 'string' ||
    requestedKey.length === 0 ||
    requestedKey.length > 70_000
  ) {
    throw new Error('Invalid media key')
  }

  const tab = await queryActiveTab()
  if (typeof tab?.id !== 'number' || !tab.url) {
    throw new Error('No active tab')
  }
  const trustedPageUrl = httpUrl(tab.url)
  if (!trustedPageUrl) throw new Error('Unsupported active tab')

  const media = (await store.get(tab.id)).find(
    (item) =>
      mediaStorageKey(item) === requestedKey && item.pageUrl === trustedPageUrl
  )
  if (!media) throw new Error('Media is no longer available on the active tab')
  return media
}
