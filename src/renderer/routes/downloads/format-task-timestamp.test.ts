import { describe, expect, it } from 'vitest'
import { formatTaskTimestamp } from './format-task-timestamp'

const now = Date.parse('2026-09-15T06:40:00Z')
const format = (
  date: string,
  locale = 'zh-CN',
  zone = 'Asia/Shanghai',
  at = now
) => formatTaskTimestamp(Date.parse(date), locale, at, zone)!

// Intl may use a non-breaking space before day periods in some ICU releases.
const spaces = (value: string) => value.replace(/[\u00a0\u202f]/g, ' ')

describe('task timestamps', () => {
  it('keeps seconds and uses local calendar days for today and yesterday', () => {
    expect(format('2026-09-15T06:32:08Z').relative).toEqual({
      date: '今天',
      time: '14:32:08',
    })
    expect(format('2026-09-14T06:32:08Z').relative?.date).toBe('昨天')
    // Only 15 minutes elapsed, but local midnight changed the calendar date.
    expect(
      format(
        '2026-09-14T15:55:08Z',
        'zh-CN',
        'Asia/Shanghai',
        Date.parse('2026-09-14T16:10:00Z')
      ).relative?.date
    ).toBe('昨天')
  })

  it('omits the current year only in the list and includes it for older dates', () => {
    const recent = format('2026-09-12T06:32:08Z')
    expect(recent.relative).toBeNull()
    expect(recent.compact).toBe('9月12日 14:32:08')
    expect(recent.full).toBe('2026年9月12日 14:32:08')
    expect(recent.detailed).toContain('GMT+8')
    expect(format('2025-12-08T06:32:08Z').compact).toBe(
      '2025年12月8日 14:32:08'
    )
    expect(recent.iso).toBe('2026-09-12T06:32:08.000Z')
  })

  it('handles yesterday across a year boundary before considering year omission', () => {
    const result = format(
      '2025-12-31T12:32:08Z',
      'en-US',
      'UTC',
      Date.parse('2026-01-01T08:00:00Z')
    )
    expect(result.relative?.date).toBe('yesterday')
    expect(spaces(result.relative!.time)).toBe('12:32:08 PM')
    expect(result.full).toContain('2025')
  })

  it.each([
    ['2026-03-08T05:10:08Z', '2026-03-09T04:05:00Z'],
    ['2026-11-01T04:10:08Z', '2026-11-02T05:05:00Z'],
  ])('handles 23-hour and 25-hour local days: %s', (timestamp, at) => {
    expect(
      format(timestamp, 'en-US', 'America/New_York', Date.parse(at)).relative
        ?.date
    ).toBe('yesterday')
  })

  it('changes calendar labels and historical offset when the viewing zone changes', () => {
    const timestamp = '2026-09-14T16:32:08Z'
    expect(format(timestamp).relative?.date).toBe('今天')
    expect(format(timestamp, 'zh-CN', 'UTC').relative?.date).toBe('昨天')
    expect(
      format('2026-01-15T06:32:08Z', 'en-US', 'America/New_York').detailed
    ).toContain('GMT-5')
    expect(
      format('2026-07-15T06:32:08Z', 'en-US', 'America/New_York').detailed
    ).toContain('GMT-4')
  })

  it.each([
    'en-US',
    'zh-CN',
    'zh-TW',
    'de-DE',
    'fr-FR',
    'ja-JP',
    'ar-EG',
    'th-TH',
    'en-US-u-hc-h23',
  ])(
    'delegates date order, digits, calendar and hour cycle to Intl: %s',
    (locale) => {
      const timestamp = Date.parse('2026-09-12T06:32:08Z')
      const result = formatTaskTimestamp(timestamp, locale, now, 'UTC')!
      const expected = new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })
      expect(result.full).toBe(expected.format(timestamp))
      expect(
        expected.formatToParts(timestamp).find((part) => part.type === 'second')
      ).toBeDefined()
      expect(formatTaskTimestamp(now, locale, now, 'UTC')!.relative!.date).toBe(
        new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
          0,
          'day'
        )
      )
    }
  )

  it('keeps an explicit calendar year across a non-Gregorian new year', () => {
    // Rosh Hashanah 2026 falls within a single Gregorian year.
    const result = format('2026-09-01T06:32:08Z', 'en-US-u-ca-hebrew', 'UTC')
    expect(result.compact).toBe(result.full)
    expect(result.full).toContain('5786')
  })

  it('does not label future dates as today or yesterday', () => {
    expect(format('2026-09-16T06:32:08Z').relative).toBeNull()
  })

  it.each([null, 0, -1, Number.NaN, Infinity, 1e20])(
    'rejects missing or invalid timestamps: %s',
    (timestamp) => {
      expect(formatTaskTimestamp(timestamp, 'en-US', now, 'UTC')).toBeNull()
    }
  )
})
