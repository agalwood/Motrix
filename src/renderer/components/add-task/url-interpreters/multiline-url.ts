import { analyzeDownloadInput } from '@shared/lib/download-source-input'
import type { InterpretResult, UrlInputInterpreter } from './types'

export const parseUrlLines = analyzeDownloadInput

export const multilineUrlInterpreter: UrlInputInterpreter = {
  id: 'builtin:multiline-url',
  name: 'Multi-line URL',
  priority: 1000,
  tryInterpret(rawText): InterpretResult | null {
    const parsed = parseUrlLines(rawText)
    const validUrls = parsed.filter((p) => p.valid).map((p) => p.url)
    if (validUrls.length === 0) return null
    return { urls: validUrls }
  },
}
