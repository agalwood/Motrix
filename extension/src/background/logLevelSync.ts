import { log } from '@/background/log'
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_KEY,
  parseLogLevel,
} from '@/shared/logLevel'

type StorageChange = { newValue?: unknown; oldValue?: unknown }

/**
 * Returns a `browser.storage.onChanged` listener that applies a persisted
 * log-level change to the running service worker's cached level. Mirrors
 * `localeSync.ts`.
 */
export function makeLogLevelChangeHandler(): (
  changes: Record<string, StorageChange>,
  area: string
) => void {
  return (changes, area) => {
    if (area !== 'local') return
    const change = changes[LOG_LEVEL_KEY]
    if (!change) return
    log.setLevel(parseLogLevel(change.newValue) ?? DEFAULT_LOG_LEVEL)
  }
}
