import type { InterpretResult, UrlInputInterpreter } from './types'

export const magnetLineInterpreter: UrlInputInterpreter = {
  id: 'builtin:magnet-line',
  name: 'Magnet Link',
  priority: 100,
  tryInterpret(rawText): InterpretResult | null {
    const trimmed = rawText.trim()
    if (trimmed.includes('\n')) return null
    if (!trimmed.startsWith('magnet:?')) return null
    return {
      urls: [trimmed],
      userNotice: { kind: 'info', messageKey: 'task.add.interpretedMagnet' },
    }
  },
}
