import {
  DEFAULT_LOG_LEVEL,
  getLogLevel,
  LOG_LEVEL_RANK,
  type LogLevel,
} from '@/shared/logLevel'

const PREFIX = '[motrix-ext]'
type MessageLevel = 'error' | 'warn' | 'info' | 'debug'

let current: LogLevel = DEFAULT_LOG_LEVEL

/** Keep credentials, signed query strings, paths and fragments out of logs. */
export function describeUrlForLog(value: string): string {
  try {
    const parsed = new URL(value)
    return parsed.host
      ? `${parsed.protocol}//${parsed.host}`
      : `${parsed.protocol}<redacted>`
  } catch {
    return '<invalid-url>'
  }
}

function emit(level: MessageLevel, args: unknown[]): void {
  if (LOG_LEVEL_RANK[level] > LOG_LEVEL_RANK[current]) return
  const tag = `${PREFIX}[${level}]`
  ;(console[level] as (...a: unknown[]) => void)(tag, ...args)
}

export const log = {
  error: (...args: unknown[]) => emit('error', args),
  warn: (...args: unknown[]) => emit('warn', args),
  info: (...args: unknown[]) => emit('info', args),
  debug: (...args: unknown[]) => emit('debug', args),
  setLevel: (level: LogLevel): void => {
    current = level
  },
}

/** Read the persisted level into the cache. Call once at background startup. */
export async function initLogLevel(): Promise<void> {
  log.setLevel(await getLogLevel())
}
