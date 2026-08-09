import { SUPPORTED_LOCALE_CODES } from '@shared/constants/locales'
import { describe, expect, it } from 'vitest'
import { formatByteParts, formatBytes, formatTime24Hour } from './format'

describe('formatBytes', () => {
  it('preserves the existing number formatting contract', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(16_500_000)).toBe('15.7 MB')
    expect(formatBytes(4_700_000_000)).toBe('4.4 GB')
  })

  it('formats decimal strings and bigint values without Number conversion', () => {
    expect(formatBytes('9007199254740992')).toBe('8.0 PB')
    expect(formatBytes(9_223_372_036_854_775_807n)).toBe('8.0 EB')
    expect(formatByteParts('9223372036854775807')).toEqual({
      number: '8.0',
      unit: 'EB',
    })
  })

  it('treats invalid and negative values as zero', () => {
    expect(formatBytes('not-a-byte-count')).toBe('0 B')
    expect(formatBytes(-1n)).toBe('0 B')
  })
})

describe('formatTime24Hour', () => {
  it.each(SUPPORTED_LOCALE_CODES)(
    'uses the locale-aware 24-hour clock with seconds in %s',
    (locale) => {
      const timestamp = new Date(2026, 6, 30, 13, 4, 5).getTime()
      const expected = new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })

      expect(formatTime24Hour(timestamp, locale)).toBe(
        expected.format(timestamp)
      )
      expect(expected.resolvedOptions().hourCycle).toBe('h23')
      expect(expected.formatToParts(timestamp).map(({ type }) => type)).toEqual(
        expect.arrayContaining(['hour', 'minute', 'second'])
      )
    }
  )
})
