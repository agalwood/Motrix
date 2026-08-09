import type { InterpretResult, UrlInputInterpreter } from './types'

const CURL_LEAD = /^\s*curl\s+/

// Tokenizer that handles single-quoted, double-quoted, and bare tokens,
// and silently swallows bash line-continuations (`\` at end of line).
function tokenize(input: string): string[] {
  const tokens: string[] = []
  const text = input.replace(/\\\s*\n/g, ' ')
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      i++
      let buf = ''
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < text.length) {
          buf += text[i + 1]
          i += 2
        } else {
          buf += text[i]
          i++
        }
      }
      i++ // skip closing quote
      tokens.push(buf)
    } else {
      let buf = ''
      while (
        i < text.length &&
        text[i] !== ' ' &&
        text[i] !== '\t' &&
        text[i] !== '\n'
      ) {
        buf += text[i]
        i++
      }
      tokens.push(buf)
    }
  }
  return tokens
}

function b64EncodeUserPass(userPass: string): string {
  if (typeof btoa === 'function') return btoa(userPass)
  // Node fallback (tests may run in jsdom or node)
  // biome-ignore lint/suspicious/noExplicitAny: allow Buffer
  const g = globalThis as any
  if (g.Buffer) return g.Buffer.from(userPass).toString('base64')
  return userPass // graceful degradation
}

export const curlInterpreter: UrlInputInterpreter = {
  id: 'builtin:curl',
  name: 'cURL command',
  priority: 10,
  tryInterpret(rawText): InterpretResult | null {
    if (!CURL_LEAD.test(rawText)) return null

    const tokens = tokenize(rawText.replace(CURL_LEAD, ''))
    if (tokens.length === 0) return null

    const urls: string[] = []
    const headers: Record<string, string> = {}
    let proxy: string | undefined
    let filename: string | undefined

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      const next = tokens[i + 1]

      if (t === '-H' || t === '--header') {
        if (next) {
          const idx = next.indexOf(':')
          if (idx > 0) {
            const name = next.slice(0, idx).trim()
            const value = next.slice(idx + 1).trim()
            headers[name] = value
          }
          i++
        }
      } else if (t === '-A' || t === '--user-agent') {
        if (next) {
          headers['User-Agent'] = next
          i++
        }
      } else if (t === '-e' || t === '--referer') {
        if (next) {
          headers.Referer = next
          i++
        }
      } else if (t === '-b' || t === '--cookie') {
        if (next) {
          headers.Cookie = next
          i++
        }
      } else if (t === '-x' || t === '--proxy') {
        if (next) {
          proxy = next
          i++
        }
      } else if (t === '-o' || t === '--output') {
        if (next) {
          filename = next
          i++
        }
      } else if (t === '-u' || t === '--user') {
        if (next) {
          headers.Authorization = `Basic ${b64EncodeUserPass(next)}`
          i++
        }
      } else if (t === '-X' || t === '--request') {
        // Method flag; consume arg, ignore
        if (next) i++
      } else if (t.startsWith('-')) {
        // Unknown single-letter or long flag; best-effort skip.
        // If it plausibly carries a value (long --foo=bar), ignore.
        // If it's a bare boolean switch (--silent), nothing to skip.
      } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) {
        urls.push(t)
      }
    }

    if (urls.length === 0) return null

    return {
      urls,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      proxy,
      filename,
      userNotice: { kind: 'info', messageKey: 'task.add.interpretedCurl' },
    }
  },
}
