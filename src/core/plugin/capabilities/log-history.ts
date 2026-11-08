import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import type { PluginLogEntry } from '@shared/types/plugin'
import { z } from 'zod'

const MAX_TAIL_BYTES = 512 * 1024
const levels: Record<number, PluginLogEntry['level']> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}
const persistedEntry = z.looseObject({
  time: z.number().min(0).max(8_640_000_000_000_000),
  level: z.number().refine((value) => Object.hasOwn(levels, value)),
  msg: z.string(),
})

/** Read a bounded tail once per plugin, including logs from earlier processes. */
export function readPluginLogTail(
  file: string,
  limit: number
): { entries: PluginLogEntry[]; needsNewline: boolean } {
  let fd: number | undefined
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { entries: [], needsNewline: false }
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES)
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_TAIL_BYTES))
    const bytes = readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n')
    // The bounded read can begin inside a record or a multibyte character.
    if (start > 0) lines.shift()
    const entries: PluginLogEntry[] = []
    for (const line of lines) {
      try {
        const parsed = persistedEntry.safeParse(JSON.parse(line))
        if (!parsed.success) continue
        const { time, level, msg, ...fields } = parsed.data
        entries.push({ ...fields, ts: time, level: levels[level], msg })
        if (entries.length > limit) entries.shift()
      } catch {
        // A partial final write or one malformed record must not hide the tail.
      }
    }
    return { entries, needsNewline: bytes > 0 && buffer[bytes - 1] !== 10 }
  } catch {
    return { entries: [], needsNewline: false }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
