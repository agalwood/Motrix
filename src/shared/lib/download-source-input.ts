import { analyzeDownloadSource } from '@shared/lib/download-source'
import {
  type DownloadSourceAnalysis,
  MAX_DOWNLOAD_INPUT_BYTES,
  MAX_DOWNLOAD_INPUT_LINES,
} from '@shared/schemas/download-source'
import { infoHashToMagnetUri } from '@shared/schemas/magnet-input'

export interface DownloadInputLine {
  line: number
  start: number
  end: number
  raw: string
  url: string
  valid: boolean
  analysis: DownloadSourceAnalysis
}

/** Check before parsing containers or splitting a potentially oversized draft. */
export function isDownloadInputTooLarge(text: string): boolean {
  return (
    text.length > MAX_DOWNLOAD_INPUT_BYTES ||
    new TextEncoder().encode(text).length > MAX_DOWNLOAD_INPUT_BYTES
  )
}

/** Textarea boundaries allow CRLF and outer ASCII spaces; API URLs do not trim. */
export function analyzeDownloadInput(text: string): DownloadInputLine[] {
  const tooLarge = isDownloadInputTooLarge(text)
  const lines = tooLarge ? [] : text.split('\n')
  if (tooLarge || lines.length > MAX_DOWNLOAD_INPUT_LINES)
    return [
      {
        line: 0,
        start: 0,
        end: text.length,
        raw: text,
        url: '',
        valid: false,
        analysis: {
          status: 'rejected',
          diagnostic: { reason: 'tooManySources', start: 0, end: text.length },
        },
      },
    ]
  const unsupportedContainer = /^\s*(?:curl(?:\.exe)?\s|["[])/i.test(text)
  let offset = 0
  return lines.flatMap((raw, line) => {
    const start = offset
    offset += raw.length + 1
    const input = raw.replace(/\r$/, '').replace(/^ +| +$/g, '')
    if (input === '') return []
    const url = input.includes('\t')
      ? input
      : (infoHashToMagnetUri(input) ?? input)
    const analysis: DownloadSourceAnalysis = unsupportedContainer
      ? {
          status: 'rejected',
          diagnostic: {
            reason: 'unsupportedInput',
            start: 0,
            end: raw.length,
          },
        }
      : analyzeDownloadSource(url)
    return [
      {
        line,
        start,
        end: start + raw.length,
        raw,
        url: analysis.status === 'accepted' ? analysis.sourceUrl : url,
        valid: analysis.status === 'accepted',
        analysis,
      },
    ]
  })
}
