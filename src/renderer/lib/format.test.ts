import { SUPPORTED_LOCALE_CODES } from '@shared/constants/locales'
import { resolveByteUnitSystem } from '@shared/schemas/byte-unit-system'
import { describe, expect, it } from 'vitest'
import {
  formatByteParts,
  formatBytes,
  formatProgressPercent,
  formatSpeed,
  formatTime24Hour,
} from './format'

describe('formatBytes', () => {
  it('uses decimal units and two decimal places for sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(16_500_000)).toBe('16.50 MB')
    expect(formatBytes(4_700_000_000)).toBe('4.70 GB')
  })

  it('formats decimal strings and bigint values without Number conversion', () => {
    expect(formatBytes('9007199254740992')).toBe('9.01 PB')
    expect(formatBytes(9_223_372_036_854_775_807n)).toBe('9.22 EB')
    expect(formatByteParts('9223372036854775807')).toEqual({
      number: '9.22',
      unit: 'EB',
    })
  })

  it('keeps binary values paired with IEC units', () => {
    expect(formatBytes(1_048_576, { unitSystem: 'binary' })).toBe('1.00 MiB')
    expect(formatBytes(1_073_741_824, { unitSystem: 'binary' })).toBe(
      '1.00 GiB'
    )
    expect(formatBytes(1_048_576)).toBe('1.05 MB')
    expect(
      formatBytes(9_223_372_036_854_775_807n, { unitSystem: 'binary' })
    ).toBe('8.00 EiB')
  })

  it('retains precision above 100 units and promotes rounded boundaries', () => {
    expect(formatBytes(123_456_789)).toBe('123.46 MB')
    expect(formatBytes(999_994)).toBe('999.99 KB')
    expect(formatBytes(999_995)).toBe('1.00 MB')
    expect(formatBytes(1_048_571, { unitSystem: 'binary' })).toBe('1.00 MiB')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('uses one decimal place for speeds in the selected system', () => {
    expect(formatSpeed(16_500_000)).toBe('16.5 MB/s')
    expect(formatSpeed(16_500_000, 'binary')).toBe('15.7 MiB/s')
    expect(formatSpeed(999_950)).toBe('1.0 MB/s')
    expect(formatSpeed(0)).toBe('0 B/s')
    expect(formatSpeed(Infinity)).toBe('0 B/s')
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

describe('formatProgressPercent', () => {
  it.each([0.9949, 0.995, 0.999, 1 - Number.EPSILON])(
    'does not report 100%% while progress is %s',
    (progress) => expect(formatProgressPercent(progress)).toBe(99)
  )
  it('reports full byte completion and handles invalid snapshots', () => {
    expect(formatProgressPercent(1)).toBe(100)
    expect(formatProgressPercent(1.01)).toBe(100)
    for (const value of [NaN, Infinity, -Infinity, -1, 0]) {
      expect(formatProgressPercent(value)).toBe(0)
    }
    expect(formatProgressPercent(0.426)).toBe(43)
  })
})

describe('system byte units', () => {
  it.each([
    ['darwin', 'decimal'],
    ['MacIntel', 'decimal'],
    ['win32', 'binary'],
    ['Win32', 'binary'],
    ['linux', 'binary'],
    ['Linux x86_64', 'binary'],
  ] as const)('uses %s platform defaults', (platform, expected) => {
    expect(resolveByteUnitSystem('system', platform)).toBe(expected)
    expect(resolveByteUnitSystem('decimal', platform)).toBe('decimal')
    expect(resolveByteUnitSystem('binary', platform)).toBe('binary')
  })
})
