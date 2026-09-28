import type { DownloadInputLine } from '@shared/lib/download-source-input'
import type { SourceReason } from '@shared/schemas/download-source'

// Other diagnostics describe the URL as a whole, rather than a precise token.
const preciseReasons = new Set<SourceReason>([
  'unsupportedProtocol',
  'invalidPercentEncoding',
  'ambiguousBackslash',
  'unescapedCharacter',
  'controlCharacter',
  'invalidUnicode',
])

export function getUrlErrorRange(line: DownloadInputLine) {
  if (line.analysis.status === 'accepted') return undefined
  const { diagnostic } = line.analysis
  if (!preciseReasons.has(diagnostic.reason)) return undefined
  const input = line.raw.replace(/\r$/, '').replace(/^ +| +$/g, '')
  // Diagnostic offsets refer to the analyzed URL. Never apply them to a
  // transformed value (for example an expanded hash) in the native textarea.
  if (input !== line.url) return undefined
  const leadingSpaces = line.raw.length - line.raw.replace(/^ +/, '').length
  const start = leadingSpaces + diagnostic.start
  const end = leadingSpaces + diagnostic.end
  if (start < 0 || end > line.raw.length || start >= end) return undefined
  return { start, end }
}

export function getUrlDisplayParts(raw: string, line?: DownloadInputLine) {
  const error = line && getUrlErrorRange(line)
  // Presentation only: never parse/serialize a URL to paint its host.
  const authority = /^ *[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/i.exec(raw)
  const hostEnd = authority?.[0].length ?? 0
  const hostStart = hostEnd - (authority?.[1].length ?? 0)
  const boundaries = [
    ...new Set([
      0,
      raw.length,
      hostStart,
      hostEnd,
      ...(error ? [error.start, error.end] : []),
    ]),
  ].sort((a, b) => a - b)
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]
    return {
      start,
      text: raw.slice(start, end),
      kind:
        error && start >= error.start && end <= error.end
          ? 'error'
          : start >= hostStart && end <= hostEnd
            ? 'host'
            : 'text',
    }
  })
}
