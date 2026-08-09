export interface InterpretResult {
  urls?: string[]
  headers?: Record<string, string>
  proxy?: string
  filename?: string
  switchToTab?: 'links' | 'torrent'
  magnetUri?: string
  userNotice?: { kind: 'info' | 'warn'; messageKey: string }
}

export interface UrlInputInterpreter {
  id: string
  name: string
  priority: number
  tryInterpret(rawText: string): InterpretResult | null
}
