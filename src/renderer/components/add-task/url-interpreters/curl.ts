import { isDownloadInputTooLarge } from '@shared/lib/download-source-input'
import { MAX_DOWNLOAD_INPUT_LINES } from '@shared/schemas/download-source'
import type { InterpretResult, UrlInputInterpreter } from './types'

const CURL_LEAD = /^\s*curl(?:\.exe)?\s+/i

/** A deliberately bounded Bash word parser. It never evaluates shell expressions. */
function tokenize(input: string): string[] | null {
  const tokens: string[] = []
  let word = ''
  let active = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (ch === '\\') {
      const next = input[++i]
      if (next === undefined) return null
      if (next === '\n') continue
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += '\\'
      word += next
      active = true
      continue
    }
    if (ch === '$' || ch === '`') return null
    if (quote === '"') {
      if (ch === '"') quote = null
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      active = true
      continue
    }
    if (/\s/.test(ch)) {
      if (active) tokens.push(word)
      word = ''
      active = false
      continue
    }
    if (/[;&|<>()^]/.test(ch)) return null
    word += ch
    active = true
  }
  if (quote) return null
  if (active) tokens.push(word)
  return tokens
}

const rejected = (): InterpretResult => ({
  rejected: true,
  userNotice: { kind: 'warn', messageKey: 'task.add.unsupportedCurl' },
})
const flags = new Set([
  '-L',
  '--location',
  '-g',
  '--globoff',
  '-s',
  '--silent',
  '-S',
  '--show-error',
  '-sS',
  '-f',
  '--fail',
  '-O',
  '--remote-name',
])
const valueFlags = new Set([
  '-H',
  '--header',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '-b',
  '--cookie',
  '-x',
  '--proxy',
  '-o',
  '--output',
  '-u',
  '--user',
  '-X',
  '--request',
  '--url',
])

export const curlInterpreter: UrlInputInterpreter = {
  id: 'builtin:curl',
  name: 'cURL command',
  priority: 10,
  tryInterpret(rawText): InterpretResult | null {
    if (!CURL_LEAD.test(rawText)) return null
    if (isDownloadInputTooLarge(rawText)) return rejected()
    if (/^\s*curl\.exe/i.test(rawText)) return rejected()
    const tokens = tokenize(rawText.replace(CURL_LEAD, ''))
    if (!tokens?.length) return rejected()
    const urls: string[] = []
    const headers: Record<string, string> = {}
    let proxy: string | undefined
    let filename: string | undefined
    let globoff = false
    const addHeader = (name: string, value: string): boolean => {
      if (
        !name ||
        /[\r\n]/.test(name + value) ||
        Object.keys(headers).some(
          (key) => key.toLowerCase() === name.toLowerCase()
        )
      )
        return false
      headers[name] = value
      return true
    }
    for (let i = 0; i < tokens.length; i++) {
      let flag = tokens[i]
      if (flags.has(flag)) {
        if (flag === '-g' || flag === '--globoff') globoff = true
        continue
      }
      let inline: string | undefined
      if (flag.startsWith('--') && flag.includes('=')) {
        const at = flag.indexOf('=')
        inline = flag.slice(at + 1)
        flag = flag.slice(0, at)
      }
      if (valueFlags.has(flag)) {
        const value = inline ?? tokens[++i]
        if (!value) return rejected()
        if (flag === '--url') urls.push(value)
        else if (flag === '-X' || flag === '--request') {
          if (value !== 'GET') return rejected()
        } else if (flag === '-x' || flag === '--proxy') {
          if (proxy !== undefined) return rejected()
          proxy = value
        } else if (flag === '-o' || flag === '--output') {
          if (filename !== undefined) return rejected()
          filename = value
        } else if (flag === '-H' || flag === '--header') {
          const at = value.indexOf(':')
          if (
            at <= 0 ||
            !addHeader(value.slice(0, at).trim(), value.slice(at + 1).trim())
          )
            return rejected()
        } else {
          const name = (
            {
              '-A': 'User-Agent',
              '--user-agent': 'User-Agent',
              '-e': 'Referer',
              '--referer': 'Referer',
              '-b': 'Cookie',
              '--cookie': 'Cookie',
              '-u': 'Authorization',
              '--user': 'Authorization',
            } as Record<string, string>
          )[flag]
          if (name === 'Cookie' && !value.includes('=')) return rejected()
          let headerValue = value
          if (name === 'Authorization') {
            if (!value.includes(':')) return rejected()
            try {
              headerValue = `Basic ${btoa(value)}`
            } catch {
              return rejected()
            }
          }
          if (!addHeader(name, headerValue)) return rejected()
        }
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(flag)) urls.push(flag)
      else return rejected()
    }
    if (
      !urls.length ||
      urls.length > MAX_DOWNLOAD_INPUT_LINES ||
      (urls.length > 1 && filename !== undefined) ||
      (!globoff &&
        urls.some((url) =>
          /[{}[\]]/.test(url.replace(/:\/\/\[[^\]]+\]/, '://host'))
        ))
    )
      return rejected()
    return {
      urls,
      headers: Object.keys(headers).length ? headers : undefined,
      proxy,
      filename,
      userNotice: { kind: 'info', messageKey: 'task.add.interpretedCurl' },
    }
  },
}
