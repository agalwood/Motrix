import type { MediaQualityHint } from './media-resolver'

/**
 * Parse a submitter's `meta.qualityLabel` into a resolver quality hint.
 *
 * The label rides an existing free-form schema field, so this parser is the
 * only vocabulary the desktop accepts: a height cap ("1080p"), the MP3
 * extraction token, or a known no-op label. Anything else — including the
 * 'auto'/'file'/'source' labels the sniffer and popup already send — yields
 * undefined and keeps today's default-format behavior untouched.
 */
const HEIGHT_LABEL = /^(\d{3,4})p$/
/** Guard against absurd values before they reach a yt-dlp selector. */
const MAX_HEIGHT = 4320

const NOOP_LABELS = new Set(['auto', 'file', 'source', 'original'])

export function parseQualityHint(
  label: string | undefined | null
): MediaQualityHint | undefined {
  if (typeof label !== 'string') return undefined
  const value = label.trim().toLowerCase()
  if (!value || NOOP_LABELS.has(value)) return undefined
  if (value === 'mp3') return { audioOnly: true }
  const match = HEIGHT_LABEL.exec(value)
  if (match) {
    const height = Number(match[1])
    if (height > 0 && height <= MAX_HEIGHT) return { height }
  }
  return undefined
}
