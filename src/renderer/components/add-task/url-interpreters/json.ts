import { isDownloadInputTooLarge } from '@shared/lib/download-source-input'
import { MAX_DOWNLOAD_INPUT_LINES } from '@shared/schemas/download-source'
import type { InterpretResult, UrlInputInterpreter } from './types'

export const jsonInterpreter: UrlInputInterpreter = {
  id: 'builtin:json',
  name: 'JSON URL input',
  priority: 20,
  tryInterpret(rawText): InterpretResult | null {
    const text = rawText.trim()
    if (!text.startsWith('"') && !text.startsWith('[')) return null
    const rejected: InterpretResult = {
      rejected: true,
      userNotice: { kind: 'warn', messageKey: 'task.add.invalidJson' },
    }
    if (isDownloadInputTooLarge(rawText)) return rejected
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return rejected
    }
    const urls = typeof parsed === 'string' ? [parsed] : parsed
    if (
      !Array.isArray(urls) ||
      !urls.length ||
      urls.length > MAX_DOWNLOAD_INPUT_LINES ||
      !urls.every((url) => typeof url === 'string' && !/[\r\n]/.test(url))
    )
      return rejected
    return {
      urls,
      userNotice: { kind: 'info', messageKey: 'task.add.interpretedJson' },
    }
  },
}
