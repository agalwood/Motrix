import type { PluginLogEntry } from '@shared/types/plugin'
import { redactLogFields } from './log-redact'

/** Apply export policy even when entries were captured in verbose mode. */
export function serializePluginLogsForExport(
  entries: readonly PluginLogEntry[]
): string {
  return JSON.stringify(
    entries.map((entry) => redactLogFields(entry, { profile: 'export' })),
    null,
    2
  )
}
