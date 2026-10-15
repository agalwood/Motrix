import type { Cookie, DownloadSubmitParams, Resource } from '@motrix/mdxp'
import {
  sanitizeFilename,
  sanitizeFilenameWithExtension,
} from '@/shared/manualTask'
import {
  type DetectedMedia,
  extensionForMediaMimeType,
  inferMediaMimeType,
} from '@/shared/media'

export interface MediaResourceCredentials {
  cookies: Cookie[]
  headers: Record<string, string>
}

export function buildMediaSubmitParams(
  media: DetectedMedia,
  cookies: Cookie[],
  headers: Record<string, string>,
  audioCredentials: MediaResourceCredentials = { cookies: [], headers: {} }
): DownloadSubmitParams {
  const primary: Resource = {
    url: media.url,
    headers,
    cookies,
    refererPolicy: 'strict-origin-when-cross-origin',
  }
  const source: DownloadSubmitParams['source'] = {
    pageUrl: media.pageUrl,
    pageTitle: media.pageTitle,
    detectedAt: media.detectedAt,
  }
  const estimatedBytes = normalizeSize(media.sizeBytes)
  const meta: DownloadSubmitParams['meta'] =
    estimatedBytes === undefined
      ? {
          suggestedFilename: deriveName(media),
          qualityLabel: 'auto',
        }
      : {
          suggestedFilename: deriveName(media),
          qualityLabel: 'auto',
          estimatedBytes,
        }
  const buildMuxSelection = () => {
    const audioUrl = media.audioUrl ?? ''
    return {
      kind: 'mux' as const,
      video: {
        url: media.url,
        headers,
        cookies,
        refererPolicy: 'strict-origin-when-cross-origin' as const,
      },
      audio: {
        url: audioUrl,
        headers: audioCredentials.headers,
        cookies: audioCredentials.cookies,
        refererPolicy: 'strict-origin-when-cross-origin' as const,
      },
      container: 'mp4' as const,
    }
  }
  const selection: DownloadSubmitParams['selection'] =
    media.kind === 'direct'
      ? { kind: 'direct', primary }
      : media.kind === 'hls'
        ? { kind: 'hls', primary, container: 'mp4' }
        : media.kind === 'dash'
          ? { kind: 'dash', primary, container: 'mp4' }
          : buildMuxSelection()
  return { source, selection, meta }
}

function deriveName(media: DetectedMedia): string {
  const fallback = media.kind === 'direct' ? 'download' : 'video'
  const candidate =
    firstNonEmpty(
      media.suggestedFilename,
      filenameFromUrl(media.url),
      media.alt,
      media.pageTitle
    ) ?? fallback

  if (media.kind !== 'direct') {
    return sanitizeFilenameWithExtension(candidate, 'mp4', fallback)
  }

  const inferredMime = inferMediaMimeType(media.url, media.mimeType)
  const extension = extensionForMediaMimeType(inferredMime ?? media.mimeType)
  const candidateMime = inferMediaMimeType(candidate)
  if (
    inferredMime &&
    candidateMime &&
    bareMimeType(candidateMime) === bareMimeType(inferredMime)
  ) {
    return sanitizeFilename(candidate, fallback)
  }
  return extension
    ? sanitizeFilenameWithExtension(candidate, extension, fallback)
    : sanitizeFilename(candidate, fallback)
}

function bareMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1)
    if (!segment) return undefined
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  } catch {
    return undefined
  }
}

function normalizeSize(sizeBytes?: number): number | undefined {
  return typeof sizeBytes === 'number' &&
    Number.isFinite(sizeBytes) &&
    sizeBytes > 0
    ? Math.round(sizeBytes)
    : undefined
}
