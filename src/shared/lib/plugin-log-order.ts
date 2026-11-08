import type { PluginLogEntry } from '../types/plugin'

export function pluginLogSequence(entry: PluginLogEntry): number | undefined {
  const value = entry.logSequence
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

/** Host sequence preserves append order across equal timestamps and clock changes. */
export function comparePluginLogs(
  a: PluginLogEntry,
  b: PluginLogEntry
): number {
  const first = pluginLogSequence(a)
  const second = pluginLogSequence(b)
  if (first !== undefined && second !== undefined) return first - second
  // Records from hosts predating sequence metadata precede newly captured logs.
  if (first !== undefined) return 1
  if (second !== undefined) return -1
  return a.ts - b.ts
}
