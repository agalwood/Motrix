const DEFAULT_MAX_EDGE = 72
const MIN_MAX_EDGE = 48
const MAX_MAX_EDGE = 96
const MAX_URL_LENGTH = 32_768
const MAX_DATA_URL_BYTES = 48 * 1024
const MAX_IMAGES_SCANNED = 4_096
const MAX_CACHE_ENTRIES = 16
const SUCCESS_CACHE_MS = 15_000
const MISS_CACHE_MS = 1_000
const ENCODE_QUALITY = 0.78

export interface ImageThumbnailRequest {
  url: string
  maxEdge?: number
}

export interface ImageThumbnailResponse {
  dataUrl: string | null
}

interface CacheEntry {
  dataUrl: string | null
  expiresAt: number
}

type ThumbnailDocument = Pick<Document, 'baseURI' | 'createElement' | 'images'>

function normalizeUrl(
  value: unknown,
  baseUrl: string | undefined
): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH
  ) {
    return null
  }

  try {
    const normalized = baseUrl ? new URL(value, baseUrl) : new URL(value)
    if (
      normalized.protocol !== 'http:' &&
      normalized.protocol !== 'https:' &&
      normalized.protocol !== 'blob:' &&
      normalized.protocol !== 'data:'
    ) {
      return null
    }
    normalized.hash = ''
    return normalized.href
  } catch {
    return null
  }
}

function readBaseUrl(doc: ThumbnailDocument): string | undefined {
  try {
    const value = doc.baseURI
    return typeof value === 'string' && value.length <= MAX_URL_LENGTH
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function maxEdgeFrom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_EDGE
  }
  return Math.min(MAX_MAX_EDGE, Math.max(MIN_MAX_EDGE, Math.round(value)))
}

function readImageUrl(
  image: HTMLImageElement,
  key: 'currentSrc' | 'src',
  baseUrl: string | undefined
): string | null {
  try {
    return normalizeUrl(image[key], baseUrl)
  } catch {
    return null
  }
}

function positiveImageDimension(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 65_535
    ? value
    : null
}

function readRenderableDimensions(
  image: HTMLImageElement
): { width: number; height: number } | null {
  try {
    if (!image.isConnected || image.complete !== true) return null
    const width = positiveImageDimension(image.naturalWidth)
    const height = positiveImageDimension(image.naturalHeight)
    return width !== null && height !== null ? { width, height } : null
  } catch {
    return null
  }
}

function imageAt(
  images: HTMLCollectionOf<HTMLImageElement>,
  index: number
): HTMLImageElement | null {
  try {
    return images.item(index)
  } catch {
    return null
  }
}

function findRenderedImage(
  doc: ThumbnailDocument,
  normalizedUrl: string,
  baseUrl: string | undefined
): { image: HTMLImageElement; width: number; height: number } | null {
  let images: HTMLCollectionOf<HTMLImageElement>
  let count: number
  try {
    images = doc.images
    count = Math.min(images.length, MAX_IMAGES_SCANNED)
  } catch {
    return null
  }

  for (let index = 0; index < count; index += 1) {
    const image = imageAt(images, index)
    if (!image) continue
    const currentSrc = readImageUrl(image, 'currentSrc', baseUrl)
    const src = readImageUrl(image, 'src', baseUrl)
    if (currentSrc !== normalizedUrl && src !== normalizedUrl) continue

    const dimensions = readRenderableDimensions(image)
    if (dimensions) return { image, ...dimensions }
  }
  return null
}

function encodeSquareThumbnail(
  doc: ThumbnailDocument,
  image: HTMLImageElement,
  width: number,
  height: number,
  maxEdge: number
): string | null {
  let canvas: HTMLCanvasElement | undefined
  try {
    canvas = doc.createElement('canvas')
    canvas.width = maxEdge
    canvas.height = maxEdge
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return null

    const sourceEdge = Math.min(width, height)
    const sourceX = (width - sourceEdge) / 2
    const sourceY = (height - sourceEdge) / 2
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceEdge,
      sourceEdge,
      0,
      0,
      maxEdge,
      maxEdge
    )

    // Browsers without WebP canvas encoding are allowed to return PNG here.
    const dataUrl = canvas.toDataURL('image/webp', ENCODE_QUALITY)
    if (
      typeof dataUrl !== 'string' ||
      dataUrl.length > MAX_DATA_URL_BYTES ||
      !/^data:image\/(?:webp|png);base64,[a-z\d+/]*={0,2}$/i.test(dataUrl)
    ) {
      return null
    }
    return dataUrl
  } catch {
    // Cross-origin images without CORS taint the canvas. Treat that, a closed
    // document, and hostile DOM accessors as an ordinary preview miss.
    return null
  } finally {
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
  }
}

/**
 * Produces small pixels only from an image the page has already loaded into
 * an <img>. It never creates an Image or performs a fetch, so a thumbnail
 * request cannot cause new network traffic or inherit page credentials.
 */
export class RenderedImageThumbnailSampler {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly doc: ThumbnailDocument = document,
    private readonly now: () => number = Date.now
  ) {}

  capture(request: unknown): ImageThumbnailResponse {
    try {
      if (typeof request !== 'object' || request === null) {
        return { dataUrl: null }
      }
      const raw = request as { url?: unknown; maxEdge?: unknown }
      const baseUrl = readBaseUrl(this.doc)
      const normalizedUrl = normalizeUrl(raw.url, baseUrl)
      if (!normalizedUrl) return { dataUrl: null }

      const maxEdge = maxEdgeFrom(raw.maxEdge)
      const cacheKey = `${normalizedUrl}\u0000${maxEdge}`
      const now = this.now()
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expiresAt > now) {
        // Refresh insertion order so frequently visible rows stay hot.
        this.cache.delete(cacheKey)
        this.cache.set(cacheKey, cached)
        return { dataUrl: cached.dataUrl }
      }
      if (cached) this.cache.delete(cacheKey)

      const match = findRenderedImage(this.doc, normalizedUrl, baseUrl)
      const dataUrl = match
        ? encodeSquareThumbnail(
            this.doc,
            match.image,
            match.width,
            match.height,
            maxEdge
          )
        : null
      this.remember(cacheKey, dataUrl, now)
      return { dataUrl }
    } catch {
      return { dataUrl: null }
    }
  }

  private remember(key: string, dataUrl: string | null, now: number): void {
    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (typeof oldest !== 'string') break
      this.cache.delete(oldest)
    }
    this.cache.set(key, {
      dataUrl,
      expiresAt: now + (dataUrl ? SUCCESS_CACHE_MS : MISS_CACHE_MS),
    })
  }
}

export const imageThumbnailSampler = new RenderedImageThumbnailSampler()
