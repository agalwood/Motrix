interface TimestampFormatters {
  calendarDay: Intl.DateTimeFormat
  calendarYear: Intl.DateTimeFormat
  compact: Intl.DateTimeFormat
  full: Intl.DateTimeFormat
  detailed: Intl.DateTimeFormat
  time: Intl.DateTimeFormat
  relative: Intl.RelativeTimeFormat
}

const cache = new Map<string, TimestampFormatters>()
let environment: { now: number; timeZone: string } | undefined

/** Resolve the device zone once per shared clock tick, including after resume. */
function localTimeZone(now: number): string {
  if (environment?.now !== now) {
    environment = {
      now,
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }
  return environment.timeZone
}

function getFormatters(locale: string, timeZone: string): TimestampFormatters {
  const key = JSON.stringify([locale, timeZone])
  const cached = cache.get(key)
  if (cached) return cached
  const dateTime: Intl.DateTimeFormatOptions = {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }
  const formatters = {
    // ISO day numbers are internal arithmetic; UI always uses the requested locale.
    calendarDay: new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }),
    calendarYear: new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      era: 'short',
    }),
    compact: new Intl.DateTimeFormat(locale, dateTime),
    full: new Intl.DateTimeFormat(locale, { ...dateTime, year: 'numeric' }),
    detailed: new Intl.DateTimeFormat(locale, {
      ...dateTime,
      year: 'numeric',
      timeZoneName: 'shortOffset',
    }),
    time: new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }),
    relative: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
  }
  // Bound the cache when users change language or device time zone repeatedly.
  if (cache.size >= 16) cache.clear()
  cache.set(key, formatters)
  return formatters
}

function calendarDay(timestamp: number, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(timestamp)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)
  // Compare calendar dates, not elapsed 24-hour periods across DST changes.
  return Date.UTC(value('year'), value('month') - 1, value('day')) / 86_400_000
}

export function formatTaskTimestamp(
  timestamp: number | null,
  locale: string,
  now: number,
  timeZone = localTimeZone(now)
) {
  if (
    timestamp === null ||
    timestamp <= 0 ||
    !Number.isFinite(new Date(timestamp).getTime())
  ) {
    return null
  }
  const f = getFormatters(locale, timeZone)
  const days =
    calendarDay(timestamp, f.calendarDay) - calendarDay(now, f.calendarDay)
  const sameYear =
    f.calendarYear.format(timestamp) === f.calendarYear.format(now)
  return {
    iso: new Date(timestamp).toISOString(),
    compact: (sameYear ? f.compact : f.full).format(timestamp),
    full: f.full.format(timestamp),
    detailed: f.detailed.format(timestamp),
    relative:
      days === 0 || days === -1
        ? {
            date: f.relative.format(days, 'day'),
            time: f.time.format(timestamp),
          }
        : null,
  }
}
