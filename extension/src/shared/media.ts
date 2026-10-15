export type MediaCategory = 'video' | 'audio' | 'image'

export interface DetectedMedia {
  kind: 'hls' | 'dash' | 'direct' | 'mux'
  url: string
  pageUrl: string
  pageTitle: string
  mimeType?: string
  audioUrl?: string
  detectedAt: number
  category?: MediaCategory
  suggestedFilename?: string
  sizeBytes?: number
  width?: number
  height?: number
  alt?: string
  frameUrl?: string
  previewable?: boolean
  evidence?: string[]
}

const HLS_CT =
  /(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)|audio\/(?:x-mpegurl|mpegurl))/i
const DASH_CT = /application\/dash\+xml/i
const DIRECT_CT = /^(audio|image|video)\//i

const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  // Video containers. Intentionally omit `.ts`: treating transport-stream
  // segments as standalone downloads makes HLS pages overwhelmingly noisy.
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  mpe: 'video/mpeg',
  ogv: 'video/ogg',
  m2ts: 'video/mp2t',
  '3gp': 'video/3gpp',

  // Audio files.
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  mid: 'audio/midi',
  midi: 'audio/midi',
  amr: 'audio/amr',

  // Images commonly exposed by `img` and `picture` elements.
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  pjp: 'image/jpeg',
  pjpeg: 'image/jpeg',
  png: 'image/png',
  apng: 'image/apng',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  jxl: 'image/jxl',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/dash+xml': 'mpd',
  'application/mpegurl': 'm3u8',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'audio/aac': 'aac',
  'audio/aiff': 'aiff',
  'audio/amr': 'amr',
  'audio/flac': 'flac',
  'audio/midi': 'mid',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mpegurl': 'm3u8',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'weba',
  'audio/x-m4a': 'm4a',
  'audio/x-mpegurl': 'm3u8',
  'audio/x-ms-wma': 'wma',
  'audio/x-wav': 'wav',
  'image/apng': 'apng',
  'image/avif': 'avif',
  'image/avif-sequence': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heic-sequence': 'heic',
  'image/heif': 'heif',
  'image/heif-sequence': 'heif',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/jxl': 'jxl',
  'image/png': 'png',
  'image/pjpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/vnd.microsoft.icon': 'ico',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/x-png': 'png',
  'video/3gpp': '3gp',
  'video/mp2t': 'm2ts',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
}

function pathnameExtension(url: string): string | null {
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    // Relative URLs are still useful to this pure classifier.
    pathname = url.split(/[?#]/, 1)[0] ?? url
  }
  const match = /\.([a-z0-9]+)$/i.exec(pathname)
  return match?.[1]?.toLowerCase() ?? null
}

function bareMimeType(mimeType?: string): string | null {
  const bare = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  return bare || null
}

/** Return the canonical filename extension for a useful media MIME. */
export function extensionForMediaMimeType(mimeType?: string): string | null {
  const bare = bareMimeType(mimeType)
  return bare ? (MIME_EXTENSIONS[bare] ?? null) : null
}

/**
 * Return a useful media MIME for UI categorisation. Response/element metadata
 * wins; when it is generic or absent, fall back to the URL extension.
 */
export function inferMediaMimeType(
  url: string,
  contentType?: string
): string | null {
  const supplied = contentType?.trim()
  const bareMime = supplied?.split(';', 1)[0]?.trim().toLowerCase()
  const extension = pathnameExtension(url)
  const extensionMime = extension
    ? (EXTENSION_MIME_TYPES[extension] ?? null)
    : null
  if (
    bareMime &&
    (DIRECT_CT.test(bareMime) ||
      HLS_CT.test(bareMime) ||
      DASH_CT.test(bareMime))
  ) {
    if (bareMime.endsWith('/*') && extensionMime) return extensionMime
    return supplied ?? null
  }
  // `application/ogg` may contain audio or video; browsers overwhelmingly use
  // it for audio downloads, and categorising it as audio is more useful than
  // falling through to the video bucket.
  if (bareMime === 'application/ogg') return 'audio/ogg'

  return extensionMime
}

/**
 * Resolve the display/storage category independently from the submission kind.
 * HLS, DASH and mux selections are video-shaped; direct resources use the
 * trusted category when present, then MIME/extension evidence.
 */
export function mediaCategory(
  media: Pick<DetectedMedia, 'category' | 'kind' | 'mimeType' | 'url'>
): MediaCategory {
  if (media.category) return media.category
  if (media.kind !== 'direct') return 'video'
  const mime = bareMimeType(
    inferMediaMimeType(media.url, media.mimeType) ?? media.mimeType
  )
  if (mime?.startsWith('audio/')) return 'audio'
  if (mime?.startsWith('image/')) return 'image'
  return 'video'
}

/**
 * Stable per-page deduplication key. Query strings are deliberately retained:
 * many CDNs sign otherwise-identical paths with distinct query parameters.
 */
export function mediaStorageKey(
  media: Pick<DetectedMedia, 'audioUrl' | 'kind' | 'url'>
): string {
  return media.kind === 'mux' && media.audioUrl
    ? `${media.url}\u0000${media.audioUrl}`
    : media.url
}

/** Shared key used by the background store and Popup session change listener. */
export function mediaTabStorageKey(tabId: number): string {
  return `media:${tabId}`
}

export function formatMediaBytes(sizeBytes?: number): string | null {
  if (!Number.isFinite(sizeBytes) || (sizeBytes ?? 0) <= 0) return null
  const bytes = sizeBytes as number
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

/** Build the compact, language-neutral metadata shown beside a resource. */
export function readableMediaMetadata(media: DetectedMedia): string {
  const format =
    media.kind === 'hls'
      ? 'HLS'
      : media.kind === 'dash'
        ? 'DASH'
        : (extensionForMediaMimeType(media.mimeType)?.toUpperCase() ??
          pathnameExtension(media.url)?.toUpperCase() ??
          mediaCategory(media).toUpperCase())
  const dimensions =
    Number.isFinite(media.width) &&
    Number.isFinite(media.height) &&
    (media.width ?? 0) > 0 &&
    (media.height ?? 0) > 0
      ? `${Math.round(media.width as number)}\u00d7${Math.round(media.height as number)}`
      : null
  return [format, dimensions, formatMediaBytes(media.sizeBytes)]
    .filter((part): part is string => Boolean(part))
    .join(' \u00b7 ')
}

export function classifyMediaUrl(
  url: string,
  contentType?: string
): 'hls' | 'dash' | 'direct' | null {
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    /* keep raw */
  }
  if (
    /\.m3u8(\?|$)/i.test(pathname) ||
    (contentType && HLS_CT.test(contentType))
  ) {
    return 'hls'
  }
  if (
    /\.mpd(\?|$)/i.test(pathname) ||
    (contentType && DASH_CT.test(contentType))
  ) {
    return 'dash'
  }
  if (inferMediaMimeType(pathname, contentType) !== null) {
    return 'direct'
  }
  return null
}

const EXCLUDED_SUFFIXES = [
  'youtube.com',
  'youtu.be',
  'googlevideo.com',
  'youtube-nocookie.com',
]

export function shouldExcludeHost(host: string, webStore: boolean): boolean {
  if (!webStore) return false
  const h = host.toLowerCase()
  return EXCLUDED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))
}

const BILIBILI_SUFFIXES = ['bilibili.com', 'b23.tv']
const YOUTUBE_SUFFIXES = ['youtube.com', 'youtu.be', 'youtube-nocookie.com']

/**
 * Returns whether the given URL is a video page that Motrix can resolve
 * server-side via its url-resolver plugin (resolveToMux seam).
 *
 * Host-match is the criteria (no path inspection): the turbo resolver decides
 * whether the specific URL is a valid video page; we simply offer the affordance.
 *
 * SP-1 web-store invariant: YouTube is excluded from web-store builds to comply
 * with store policies. bilibili is always allowed.
 */
export function isResolvableVideoPage(
  url: string,
  webStore: boolean
): { resolvable: true; site: 'bilibili' | 'youtube' } | { resolvable: false } {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
    if (!hostname) return { resolvable: false }
  } catch {
    return { resolvable: false }
  }
  if (
    BILIBILI_SUFFIXES.some((s) => hostname === s || hostname.endsWith(`.${s}`))
  ) {
    return { resolvable: true, site: 'bilibili' }
  }
  if (
    !webStore &&
    YOUTUBE_SUFFIXES.some((s) => hostname === s || hostname.endsWith(`.${s}`))
  ) {
    return { resolvable: true, site: 'youtube' }
  }
  return { resolvable: false }
}
