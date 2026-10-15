/**
 * Wire shape of the fork-local `media/formats` MDXP method — mirrors
 * `src/shared/schemas/media-formats.ts` in the desktop app (the extension
 * cannot import it; the two must stay aligned).
 *
 * `key` is the quality token echoed back as `meta.qualityLabel` on submit —
 * never a raw yt-dlp selector.
 */
export interface MediaFormatEntry {
  key: string
  kind: 'video' | 'audio'
  /** Display label, e.g. "1080p" or "MP3". */
  label: string
  height?: number
  fps?: number
  ext?: string
  sizeBytes?: number
}

export interface MediaFormatsParams {
  url: string
  cookies?: Array<{ name: string; value: string }>
}

export interface MediaFormatsResult {
  available: boolean
  /** Machine-readable reason when `available` is false. */
  reason?: string
  title?: string
  durationSec?: number
  entries: MediaFormatEntry[]
}

/** The only quality tokens the desktop parser accepts from a submit. */
export const QUALITY_LABEL_PATTERN = /^(auto|\d{3,4}p|mp3)$/i

/** `meta.qualityLabel` vocabulary for a quality-picker submit. */
export type QualityLabel = 'auto' | 'mp3' | `${number}p`

/**
 * A REAL picker choice (never the 'auto' default): the desktop treats such a
 * label as the submitter having picked from THIS url's own format list, so
 * the page-submit resolvability gate is relaxed for it.
 */
export function isPickerQualityHint(
  value: unknown
): value is 'mp3' | `${number}p` {
  return typeof value === 'string' && /^(mp3|\d{3,4}p)$/i.test(value)
}

/** Validate + lowercase a client-supplied label; anything else → 'auto'. */
export function normalizeQualityLabel(value: unknown): QualityLabel {
  if (typeof value !== 'string') return 'auto'
  const trimmed = value.trim().toLowerCase()
  return QUALITY_LABEL_PATTERN.test(trimmed)
    ? (trimmed as QualityLabel)
    : 'auto'
}
