export type { ByteValue, FormattedByteParts } from '@shared/utils/format-bytes'
export {
  formatByteParts,
  formatBytes,
  formatSpeed,
} from '@shared/utils/format-bytes'

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const time24HourFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Shared `dateStyle: 'medium'` + `timeStyle: 'short'` timestamp formatting.
 * Formatter construction is expensive, so instances are cached per locale.
 */
export function formatDateTime(ms: number, locale: string): string {
  let formatter = dateTimeFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    dateTimeFormatters.set(locale, formatter)
  }
  return formatter.format(ms)
}

/**
 * Locale-aware 24-hour clock with second precision.
 */
export function formatTime24Hour(ms: number, locale: string): string {
  let formatter = time24HourFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    time24HourFormatters.set(locale, formatter)
  }
  return formatter.format(ms)
}

export function formatDurationHMS(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** Round display percentages without claiming completion while bytes remain. */
export function formatProgressPercent(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0
  return progress >= 1 ? 100 : Math.min(99, Math.round(progress * 100))
}
