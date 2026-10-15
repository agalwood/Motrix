import type { DetectedMedia } from '@/shared/media'

export type ImageQuickFilterOperator = 'gte' | 'eq' | 'lte'

export interface ImageQuickFilterCondition {
  operator: ImageQuickFilterOperator
  value: number
}

export interface ImageQuickFilters {
  formats: string[]
  width?: ImageQuickFilterCondition
  height?: ImageQuickFilterCondition
  /** File size in bytes. */
  size?: ImageQuickFilterCondition
}

export type ImageQuickFilterMetric = 'width' | 'height' | 'size'

export type CanonicalImageFormat =
  | 'JPG'
  | 'PNG'
  | 'WEBP'
  | 'GIF'
  | 'AVIF'
  | 'APNG'
  | 'BMP'
  | 'ICO'
  | 'TIFF'
  | 'HEIC'
  | 'HEIF'
  | 'JXL'
  | 'OTHER'

const FORMAT_ORDER: readonly CanonicalImageFormat[] = [
  'JPG',
  'PNG',
  'WEBP',
  'GIF',
  'AVIF',
  'APNG',
  'BMP',
  'ICO',
  'TIFF',
  'HEIC',
  'HEIF',
  'JXL',
  'OTHER',
]

const FORMAT_SET = new Set<string>(FORMAT_ORDER)
const MAX_IMAGE_DIMENSION = 100_000

const MIME_FORMATS: Readonly<Record<string, CanonicalImageFormat>> = {
  'image/apng': 'APNG',
  'image/avif': 'AVIF',
  'image/avif-sequence': 'AVIF',
  'image/bmp': 'BMP',
  'image/gif': 'GIF',
  'image/heic': 'HEIC',
  'image/heic-sequence': 'HEIC',
  'image/heif': 'HEIF',
  'image/heif-sequence': 'HEIF',
  'image/jfif': 'JPG',
  'image/jpeg': 'JPG',
  'image/jpg': 'JPG',
  'image/jxl': 'JXL',
  'image/pjpeg': 'JPG',
  'image/png': 'PNG',
  'image/tiff': 'TIFF',
  'image/vnd.microsoft.icon': 'ICO',
  'image/vnd.mozilla.apng': 'APNG',
  'image/webp': 'WEBP',
  'image/x-bmp': 'BMP',
  'image/x-icon': 'ICO',
  'image/x-ms-bmp': 'BMP',
  'image/x-png': 'PNG',
}

const EXTENSION_FORMATS: Readonly<Record<string, CanonicalImageFormat>> = {
  apng: 'APNG',
  avif: 'AVIF',
  bmp: 'BMP',
  gif: 'GIF',
  heic: 'HEIC',
  heif: 'HEIF',
  ico: 'ICO',
  jfif: 'JPG',
  jpe: 'JPG',
  jpeg: 'JPG',
  jpg: 'JPG',
  jxl: 'JXL',
  pjp: 'JPG',
  pjpeg: 'JPG',
  png: 'PNG',
  tif: 'TIFF',
  tiff: 'TIFF',
  webp: 'WEBP',
}

export const EMPTY_IMAGE_QUICK_FILTERS: ImageQuickFilters = { formats: [] }

function bareMimeType(mimeType: unknown): string | null {
  if (typeof mimeType !== 'string') return null
  const bare = mimeType.split(';', 1)[0]?.trim().toLowerCase()
  return bare || null
}

function urlExtension(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url.split(/[?#]/, 1)[0] ?? url
  }
  return /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase() ?? null
}

/** Return a compact, language-independent format label for one image. */
export function canonicalImageFormat(
  media: Pick<DetectedMedia, 'mimeType' | 'url'>
): CanonicalImageFormat {
  const mimeType = bareMimeType(media.mimeType)
  if (mimeType) {
    const mimeFormat = MIME_FORMATS[mimeType]
    if (mimeFormat) return mimeFormat
    // A concrete image MIME is more trustworthy than a filename suffix. This
    // also keeps unsupported formats such as SVG together under `OTHER`.
    if (mimeType.startsWith('image/') && mimeType !== 'image/*') return 'OTHER'
  }

  const extension = urlExtension(media.url)
  return (extension && EXTENSION_FORMATS[extension]) || 'OTHER'
}

/** Return the formats present in the list using a fixed, non-page-controlled order. */
export function availableImageFormats(
  media: ReadonlyArray<Pick<DetectedMedia, 'mimeType' | 'url'>>
): CanonicalImageFormat[] {
  const present = new Set(media.map(canonicalImageFormat))
  return FORMAT_ORDER.filter((format) => present.has(format))
}

function normalizedFormat(value: unknown): CanonicalImageFormat | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  const alias = normalized === 'JPEG' ? 'JPG' : normalized
  return FORMAT_SET.has(alias) ? (alias as CanonicalImageFormat) : null
}

function maximumForMetric(metric: ImageQuickFilterMetric): number {
  return metric === 'size' ? Number.MAX_SAFE_INTEGER : MAX_IMAGE_DIMENSION
}

/** Validate a condition coming from form or persisted state without coercion. */
export function normalizeImageQuickFilterCondition(
  condition: unknown,
  metric: ImageQuickFilterMetric
): ImageQuickFilterCondition | undefined {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return undefined
  }
  const { operator, value } = condition as Record<string, unknown>
  if (operator !== 'gte' && operator !== 'eq' && operator !== 'lte') {
    return undefined
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximumForMetric(metric)
  ) {
    return undefined
  }
  return { operator, value }
}

/** Canonicalize formats and remove malformed numeric conditions. */
export function normalizeImageQuickFilters(
  filters: unknown
): ImageQuickFilters {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    return { formats: [] }
  }
  const value = filters as Record<string, unknown>
  const seenFormats = new Set<CanonicalImageFormat>()
  if (Array.isArray(value.formats)) {
    for (const entry of value.formats) {
      const format = normalizedFormat(entry)
      if (format) seenFormats.add(format)
    }
  }
  const formats = FORMAT_ORDER.filter((format) => seenFormats.has(format))
  const width = normalizeImageQuickFilterCondition(value.width, 'width')
  const height = normalizeImageQuickFilterCondition(value.height, 'height')
  const size = normalizeImageQuickFilterCondition(value.size, 'size')
  return {
    formats,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(size ? { size } : {}),
  }
}

function knownMetricValue(
  value: unknown,
  metric: ImageQuickFilterMetric
): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximumForMetric(metric)
    ? value
    : null
}

function matchesCondition(
  actual: number | null,
  condition: ImageQuickFilterCondition | undefined
): boolean {
  if (!condition) return true
  if (actual === null) return false
  if (condition.operator === 'gte') return actual >= condition.value
  if (condition.operator === 'lte') return actual <= condition.value
  return actual === condition.value
}

export function matchesImageQuickFilters(
  media: Pick<
    DetectedMedia,
    'height' | 'mimeType' | 'sizeBytes' | 'url' | 'width'
  >,
  filters: unknown
): boolean {
  const normalized = normalizeImageQuickFilters(filters)
  if (
    normalized.formats.length > 0 &&
    !normalized.formats.includes(canonicalImageFormat(media))
  ) {
    return false
  }
  return (
    matchesCondition(
      knownMetricValue(media.width, 'width'),
      normalized.width
    ) &&
    matchesCondition(
      knownMetricValue(media.height, 'height'),
      normalized.height
    ) &&
    matchesCondition(knownMetricValue(media.sizeBytes, 'size'), normalized.size)
  )
}

/** Formats count as one active filter, regardless of how many are selected. */
export function countActiveImageQuickFilters(filters: unknown): number {
  const normalized = normalizeImageQuickFilters(filters)
  return (
    (normalized.formats.length > 0 ? 1 : 0) +
    Number(Boolean(normalized.width)) +
    Number(Boolean(normalized.height)) +
    Number(Boolean(normalized.size))
  )
}
