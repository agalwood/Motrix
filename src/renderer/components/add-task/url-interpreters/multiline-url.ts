import type { InterpretResult, UrlInputInterpreter } from './types'

export interface ParsedLine {
  line: number
  url: string
  valid: boolean
}

const VALID_SCHEMES = ['http:', 'https:', 'ftp:']

export function parseUrlLines(text: string): ParsedLine[] {
  const out: ParsedLine[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '') continue
    let valid = false
    if (trimmed.startsWith('magnet:')) {
      valid = trimmed.startsWith('magnet:?')
    } else {
      try {
        const u = new URL(trimmed)
        valid = VALID_SCHEMES.includes(u.protocol)
      } catch {
        valid = false
      }
    }
    out.push({ line: i, url: trimmed, valid })
  }
  return out
}

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
