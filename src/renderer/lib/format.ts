const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const
const BYTE_BASE = 1024n

export type ByteValue = number | bigint | string

export interface FormattedByteParts {
  number: string
  unit: (typeof BYTE_UNITS)[number]
}

function toByteCount(value: ByteValue): bigint {
  if (typeof value === 'bigint') return value > 0n ? value : 0n
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0n
    return BigInt(Math.floor(value))
  }
  if (!/^\d+$/.test(value)) return 0n
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

export function formatByteParts(bytes: ByteValue): FormattedByteParts {
  const value = toByteCount(bytes)
  if (value === 0n) return { number: '0', unit: 'B' }

  let unitIndex = 0
  let unitSize = 1n
  while (unitIndex < BYTE_UNITS.length - 1 && value >= unitSize * BYTE_BASE) {
    unitIndex += 1
    unitSize *= BYTE_BASE
  }

  if (unitIndex === 0) {
    return { number: value.toString(), unit: BYTE_UNITS[unitIndex] }
  }

  if (value >= unitSize * 100n) {
    return {
      number: ((value + unitSize / 2n) / unitSize).toString(),
      unit: BYTE_UNITS[unitIndex],
    }
  }

  const tenths = (value * 10n + unitSize / 2n) / unitSize
  return {
    number: `${tenths / 10n}.${tenths % 10n}`,
    unit: BYTE_UNITS[unitIndex],
  }
}

export function formatBytes(bytes: ByteValue): string {
  const parts = formatByteParts(bytes)
  return `${parts.number} ${parts.unit}`
}

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
