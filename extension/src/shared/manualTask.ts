import { ResourceSchema } from '@motrix/mdxp'
import type { TaskOptions } from '@/shared/taskOptions'

export interface CreateManualTaskRequest {
  options?: TaskOptions
  pairIfNeeded?: boolean

  input: string
  idempotencyKey: string
}

/** The first popup iteration accepts one URL or magnet per submission. */
export type ParsedManualTaskInput =
  | {
      kind: 'direct'
      url: string
      suggestedFilename: string
    }
  | {
      kind: 'magnet'
      uri: string
      suggestedFilename: string
    }

export type ManualTaskParseReason = 'empty' | 'invalid' | 'unsupported'

export type ManualTaskParseResult =
  | { ok: true; value: ParsedManualTaskInput }
  | { ok: false; reason: ManualTaskParseReason }

export const MAX_MANUAL_TASK_FILENAME_LENGTH = 255

const FALLBACK_HTTP_FILENAME = 'download'
const FALLBACK_MAGNET_FILENAME = 'magnet-download'
const ManualTaskHttpUrl = ResourceSchema.shape.url

/**
 * Parse user-pasted input without consulting tabs, cookies, or browser state.
 * Keeping this pure lets the popup validate with the same rules enforced by
 * the background handler.
 */
export function parseManualTaskInput(raw: unknown): ManualTaskParseResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'empty' }
  }

  const input = raw.trim()
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: 'invalid' }
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    // Share MDXP's resource contract so popup and receiver validation agree.
    if (!ManualTaskHttpUrl.safeParse(url.href).success) {
      return { ok: false, reason: 'invalid' }
    }
    return {
      ok: true,
      value: {
        kind: 'direct',
        url: url.href,
        suggestedFilename: filenameFromHttpUrl(url),
      },
    }
  }

  // URL canonicalizes scheme casing, so the resulting URI also satisfies
  // MDXP's exact `startsWith('magnet:?')` selection contract.
  if (url.protocol === 'magnet:' && url.href.startsWith('magnet:?')) {
    if (!url.searchParams.getAll('xt').some((value) => value.trim() !== '')) {
      return { ok: false, reason: 'invalid' }
    }
    return {
      ok: true,
      value: {
        kind: 'magnet',
        uri: url.href,
        suggestedFilename: sanitizeFilename(
          url.searchParams.get('dn') ?? '',
          FALLBACK_MAGNET_FILENAME
        ),
      },
    }
  }

  return { ok: false, reason: 'unsupported' }
}

function filenameFromHttpUrl(url: URL): string {
  const encodedSegment = url.pathname.split('/').at(-1) ?? ''
  let segment = encodedSegment
  try {
    segment = decodeURIComponent(encodedSegment)
  } catch {
    // A malformed percent escape is still a valid WHATWG URL. Keep its
    // encoded form and sanitize it instead of rejecting an otherwise usable
    // download URL.
  }
  return sanitizeFilename(segment, FALLBACK_HTTP_FILENAME)
}

/** Characters forbidden or troublesome on Windows, macOS, and Linux. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are intentionally removed from filenames
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f\x7f]/g
/** Invisible direction overrides can disguise an executable suffix. */
const BIDI_FILENAME_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export function sanitizeFilename(value: string, fallback: string): string {
  const safeFallback =
    fallback
      .normalize('NFC')
      .replace(BIDI_FILENAME_CONTROLS, '')
      .replace(UNSAFE_FILENAME_CHARS, '_')
      .trim()
      .replace(/[. ]+$/g, '') || 'download'
  let safe = value
    .normalize('NFC')
    .replace(BIDI_FILENAME_CONTROLS, '')
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .trim()
    .replace(/[. ]+$/g, '')

  if (safe === '' || safe === '.' || safe === '..') safe = safeFallback
  if (WINDOWS_DEVICE_NAME.test(safe)) safe = `_${safe}`

  safe = truncateWithoutSplittingSurrogate(
    safe,
    MAX_MANUAL_TASK_FILENAME_LENGTH
  )
    .trim()
    .replace(/[. ]+$/g, '')

  return safe || safeFallback
}

/**
 * Sanitize a filename and force a trusted canonical extension. The suffix is
 * budgeted before truncation so a long Unicode stem can never remove it or be
 * cut between a surrogate pair.
 */
export function sanitizeFilenameWithExtension(
  value: string,
  extension: string,
  fallback: string
): string {
  const canonicalExtension = extension
    .normalize('NFC')
    .replace(BIDI_FILENAME_CONTROLS, '')
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 32)
  if (!canonicalExtension) return sanitizeFilename(value, fallback)

  const suffix = `.${canonicalExtension}`
  const safe = sanitizeFilename(value, fallback)
  const existingExtension = /\.([a-z0-9]{1,16})$/i.exec(safe)
  const rawStem = existingExtension
    ? safe.slice(0, -existingExtension[0].length)
    : safe
  const deduplicatedStem = rawStem.toLowerCase().endsWith(suffix)
    ? rawStem.slice(0, -suffix.length)
    : rawStem
  const fallbackSafe = sanitizeFilename(fallback, 'download')
  const fallbackStem =
    fallbackSafe.replace(/\.([a-z0-9]{1,16})$/i, '') || 'download'
  const safeStem = sanitizeFilename(deduplicatedStem, fallbackStem)
  const available = Math.max(1, MAX_MANUAL_TASK_FILENAME_LENGTH - suffix.length)
  const stem = truncateWithoutSplittingSurrogate(safeStem, available)
    .trim()
    .replace(/[. ]+$/g, '')
  return `${stem || fallbackStem}${suffix}`
}

function truncateWithoutSplittingSurrogate(value: string, max: number): string {
  if (value.length <= max) return value
  let result = value.slice(0, max)
  const last = result.charCodeAt(result.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1)
  return result
}
