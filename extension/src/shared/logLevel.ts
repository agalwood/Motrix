import { extensionBrowser as browser } from '@/shared/browser'
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

export const LOG_LEVEL_KEY = 'motrix.logLevel'
export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

export function parseLogLevel(v: unknown): LogLevel | null {
  return v === 'silent' ||
    v === 'error' ||
    v === 'warn' ||
    v === 'info' ||
    v === 'debug'
    ? v
    : null
}

export async function getLogLevel(): Promise<LogLevel> {
  const got = await browser.storage.local.get(LOG_LEVEL_KEY)
  return parseLogLevel(got[LOG_LEVEL_KEY]) ?? DEFAULT_LOG_LEVEL
}

export async function setLogLevel(v: LogLevel): Promise<void> {
  await browser.storage.local.set({ [LOG_LEVEL_KEY]: v })
}
