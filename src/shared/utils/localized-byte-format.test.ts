import { SUPPORTED_LOCALE_CODES } from '@shared/constants/locales'
import type { ByteUnitSystem } from '@shared/schemas/byte-unit-system'
import { I18N_RESOURCES } from '@test-utils/i18n-resources'
import { createInstance } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { createLocalizedByteFormatter } from './localized-byte-format'

const i18n = createInstance()
beforeAll(async () => {
  await i18n.init({
    resources: I18N_RESOURCES,
    lng: 'en-US',
    interpolation: { escapeValue: false },
  })
})
const formatter = (locale: string, system: ByteUnitSystem = 'binary') =>
  createLocalizedByteFormatter(system, locale, i18n.getFixedT(locale))

describe('localized information units', () => {
  it.each([
    ['en-US', '1.50 MiB/s', '1 MiB/s'],
    ['fr', '1,50 Mio/s', '1 Mio/s'],
    ['ru', '1,50 МиБ/с', '1 МиБ/с'],
    ['uk', '1,50 МіБ/с', '1 МіБ/с'],
    ['ro', '1,50 MiO/s', '1 MiO/s'],
    ['ja', '1.50 MiB/秒', '1 MiB/秒'],
    ['zh-CN', '1.50 MiB/s', '1 MiB/s'],
    ['ar-u-nu-arab', '١٫٥٠ MiB/ث', '١ MiB/ث'],
  ])(
    'formats sizes and speeds in %s without changing the base',
    (locale, size, limit) => {
      const f = formatter(locale)
      expect(f.formatBytes(1_572_864)).toBe(
        size.slice(0, size.lastIndexOf('/'))
      )
      expect(f.formatSpeed(1_572_864)).toBe(
        size.replace(/50|٥٠/, (fraction) => fraction[0])
      )
      expect(f.formatSpeedLimit(1_048_576)).toBe(limit)
      expect(f.formatByteUnit('MiB', true)).toBe(
        limit.slice(limit.indexOf(' ') + 1)
      )
    }
  )

  it('keeps decimal and binary selection independent of language', () => {
    expect(formatter('fr', 'decimal').formatBytes(1_048_576)).toBe('1,05 Mo')
    expect(formatter('fr', 'binary').formatBytes(1_048_576)).toBe('1,00 Mio')
    expect(formatter('fr', 'decimal').formatByteQuantity(16, 'MiB')).toBe(
      '16 Mio'
    )
  })

  it('preserves exact large integers, trailing precision, and rounding promotion', () => {
    const f = formatter('fr', 'decimal')
    const huge = '1234567890123456789012345678901234567890'
    expect(f.formatBytes(huge)).toBe('1234567890123456789012,35 Eo')
    expect(f.formatBytes(BigInt(huge))).toBe(f.formatBytes(huge))
    expect(f.formatBytes(999_995, { decimals: 2 })).toBe('1,00 Mo')
    expect(f.formatSpeed(1_000_000)).toBe('1,0 Mo/s')
    expect(f.formatSpeedLimit(1_500_000)).toBe('1,5 Mo/s')
    expect(f.formatBytes(-1)).toBe('0 o')
  })

  it.each(SUPPORTED_LOCALE_CODES)(
    'has usable, distinct SI and IEC labels in %s',
    (locale) => {
      const f = formatter(locale)
      for (const [decimal, binary] of [
        ['KB', 'KiB'],
        ['MB', 'MiB'],
        ['GB', 'GiB'],
        ['TB', 'TiB'],
        ['PB', 'PiB'],
        ['EB', 'EiB'],
      ] as const) {
        expect(f.formatByteUnit(decimal)).not.toBe(f.formatByteUnit(binary))
        expect(f.formatByteUnit(binary, true)).not.toMatch(/units\.|\{\{/)
      }
    }
  )
})
