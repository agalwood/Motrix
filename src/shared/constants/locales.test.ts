import { describe, expect, it } from 'vitest'
import {
  canonicalizeLocale,
  DEFAULT_LOCALE,
  getLocaleDefinition,
  getLocaleDirection,
  isSupportedLocale,
  resolveSupportedLocale,
  SUPPORTED_LOCALE_CODES,
  SUPPORTED_LOCALES,
} from './locales'

describe('locale catalog', () => {
  it('marks Arabic and Persian as RTL and all other bundled locales as LTR', () => {
    for (const locale of SUPPORTED_LOCALE_CODES) {
      expect(getLocaleDirection(locale)).toBe(
        ['ar', 'fa'].includes(locale) ? 'rtl' : 'ltr'
      )
    }
  })

  it('keeps locale codes unique and default registered', () => {
    expect(new Set(SUPPORTED_LOCALE_CODES).size).toBe(
      SUPPORTED_LOCALE_CODES.length
    )
    expect(SUPPORTED_LOCALE_CODES).toContain(DEFAULT_LOCALE)
    expect(SUPPORTED_LOCALES).toHaveLength(SUPPORTED_LOCALE_CODES.length)
    expect(SUPPORTED_LOCALE_CODES).toEqual([...SUPPORTED_LOCALE_CODES].sort())
  })

  it('provides metadata for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALE_CODES) {
      const definition = getLocaleDefinition(locale)
      expect(definition).toMatchObject({ code: locale })
      expect(definition.nativeName.trim()).not.toBe('')
      expect(['ltr', 'rtl']).toContain(definition.dir)
      expect(canonicalizeLocale(locale)).toBe(locale)
    }
  })
})

describe('canonicalizeLocale', () => {
  it('normalizes underscores and BCP-47 casing', () => {
    expect(canonicalizeLocale('zh_cn')).toBe('zh-CN')
    expect(canonicalizeLocale('EN-us')).toBe('en-US')
    expect(canonicalizeLocale('zh_CN.UTF-8')).toBe('zh-CN')
  })

  it.each(['', 'auto', 'SYSTEM', 'C.UTF-8', 'POSIX', 'not_a_locale!'])(
    'rejects the sentinel or invalid value %s',
    (value) => {
      expect(canonicalizeLocale(value)).toBeNull()
    }
  )
})

describe('resolveSupportedLocale', () => {
  it.each([
    ['ar-SA', 'ar'],
    ['bg-BG', 'bg'],
    ['ca-ES', 'ca'],
    ['el-GR', 'el'],
    ['fa-IR', 'fa'],
    ['nb-NO', 'nb'],
    ['nl-NL', 'nl'],
    ['ro-RO', 'ro'],
    ['th-TH', 'th'],
    ['uk-UA', 'uk'],
  ])(
    'resolves %s to %s without accepting regional preferences',
    (candidate, locale) => {
      expect(resolveSupportedLocale(candidate)).toBe(locale)
      expect(
        resolveSupportedLocale(`${candidate.replace('-', '_')}.UTF-8`)
      ).toBe(locale)
      expect(isSupportedLocale(locale)).toBe(true)
      expect(isSupportedLocale(candidate)).toBe(false)
    }
  )

  it('returns exact and normalized supported matches', () => {
    expect(resolveSupportedLocale('zh-CN')).toBe('zh-CN')
    expect(resolveSupportedLocale('zh_cn')).toBe('zh-CN')
    expect(resolveSupportedLocale('zh-TW')).toBe('zh-TW')
    expect(resolveSupportedLocale('zh_tw')).toBe('zh-TW')
  })

  it('falls back by language for regional and script variants', () => {
    expect(resolveSupportedLocale('zh-Hans-SG')).toBe('zh-CN')
    expect(resolveSupportedLocale('zh-Hant-TW')).toBe('zh-TW')
  })

  it.each(['fr', 'fr-FR', 'fr-CA', 'fr_BE.UTF-8'])(
    'resolves French locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('fr')
    }
  )

  it('tries later candidates before the default', () => {
    expect(resolveSupportedLocale('qaa', 'zh-CN')).toBe('zh-CN')
  })

  it.each(['de', 'de-DE', 'de-AT', 'de-CH', 'de_DE.UTF-8'])(
    'resolves German locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('de')
    }
  )

  it.each(['id', 'id-ID', 'id_ID.UTF-8', 'in-ID'])(
    'resolves Indonesian locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('id')
    }
  )

  it.each(['it', 'it-IT', 'it-CH', 'it_IT.UTF-8'])(
    'resolves Italian locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('it')
    }
  )

  it.each(['ja', 'ja-JP', 'ja-Jpan-JP', 'ja_JP.UTF-8'])(
    'resolves Japanese locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('ja')
    }
  )

  it.each(['ko', 'ko-KR', 'ko-Kore-KR', 'ko_KR.UTF-8'])(
    'resolves Korean locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('ko')
    }
  )

  it('uses the default when no candidate is supported', () => {
    expect(resolveSupportedLocale('qaa')).toBe(DEFAULT_LOCALE)
  })

  it.each(['pl', 'pl-PL', 'pl_PL.UTF-8'])(
    'resolves Polish locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('pl')
    }
  )

  it.each(['pt-BR', 'pt', 'pt-PT', 'pt_BR.UTF-8'])(
    'resolves Portuguese locale %s to the bundled Brazilian resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('pt-BR')
    }
  )

  it.each(['ru', 'ru-RU', 'ru-BY', 'ru_RU.UTF-8'])(
    'resolves Russian locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('ru')
    }
  )

  it.each(['tr', 'tr-TR', 'tr-CY', 'tr_TR.UTF-8', 'TR-tr'])(
    'resolves Turkish locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('tr')
    }
  )

  it.each(['vi', 'vi-VN', 'vi_VN.UTF-8', 'VI-vn'])(
    'resolves Vietnamese locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('vi')
    }
  )

  it.each(['es', 'es-ES', 'es-MX', 'es-419', 'es_ES.UTF-8'])(
    'resolves Spanish locale %s to the bundled resource',
    (locale) => {
      expect(resolveSupportedLocale(locale, 'en-US')).toBe('es')
    }
  )
})

describe('isSupportedLocale', () => {
  it('accepts only exact catalog values', () => {
    expect(isSupportedLocale('en-US')).toBe(true)
    expect(isSupportedLocale('de')).toBe(true)
    expect(isSupportedLocale('de-DE')).toBe(false)
    expect(isSupportedLocale('es')).toBe(true)
    expect(isSupportedLocale('es-ES')).toBe(false)
    expect(isSupportedLocale('fr')).toBe(true)
    expect(isSupportedLocale('id')).toBe(true)
    expect(isSupportedLocale('id-ID')).toBe(false)
    expect(isSupportedLocale('in')).toBe(false)
    expect(isSupportedLocale('it')).toBe(true)
    expect(isSupportedLocale('it-IT')).toBe(false)
    expect(isSupportedLocale('ja')).toBe(true)
    expect(isSupportedLocale('ja-JP')).toBe(false)
    expect(isSupportedLocale('ko')).toBe(true)
    expect(isSupportedLocale('ko-KR')).toBe(false)
    expect(isSupportedLocale('pl')).toBe(true)
    expect(isSupportedLocale('pl-PL')).toBe(false)
    expect(isSupportedLocale('pt-BR')).toBe(true)
    expect(isSupportedLocale('pt')).toBe(false)
    expect(isSupportedLocale('pt-PT')).toBe(false)
    expect(isSupportedLocale('ru')).toBe(true)
    expect(isSupportedLocale('ru-RU')).toBe(false)
    expect(isSupportedLocale('tr')).toBe(true)
    expect(isSupportedLocale('tr-TR')).toBe(false)
    expect(isSupportedLocale('vi')).toBe(true)
    expect(isSupportedLocale('vi-VN')).toBe(false)
    expect(isSupportedLocale('zh-CN')).toBe(true)
    expect(isSupportedLocale('zh-TW')).toBe(true)
    expect(isSupportedLocale('zh_cn')).toBe(false)
    expect(isSupportedLocale('zh_tw')).toBe(false)
    expect(isSupportedLocale('fr-FR')).toBe(false)
  })
})
