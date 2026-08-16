import { describe, expect, it } from 'vitest'
import {
  canonicalizeLocale,
  DEFAULT_LOCALE,
  getLocaleDefinition,
  isSupportedLocale,
  resolveSupportedLocale,
  SUPPORTED_LOCALE_CODES,
  SUPPORTED_LOCALES,
} from './locales'

describe('locale catalog', () => {
  it('keeps locale codes unique and default registered', () => {
    expect(new Set(SUPPORTED_LOCALE_CODES).size).toBe(
      SUPPORTED_LOCALE_CODES.length
    )
    expect(SUPPORTED_LOCALE_CODES).toContain(DEFAULT_LOCALE)
    expect(SUPPORTED_LOCALES).toHaveLength(SUPPORTED_LOCALE_CODES.length)
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

  it('tries later candidates before the default', () => {
    expect(resolveSupportedLocale('fr-FR', 'zh-CN')).toBe('zh-CN')
  })

  it('uses the default when no candidate is supported', () => {
    expect(resolveSupportedLocale('fr-FR')).toBe(DEFAULT_LOCALE)
  })
})

describe('isSupportedLocale', () => {
  it('accepts only exact catalog values', () => {
    expect(isSupportedLocale('en-US')).toBe(true)
    expect(isSupportedLocale('zh-CN')).toBe(true)
    expect(isSupportedLocale('zh-TW')).toBe(true)
    expect(isSupportedLocale('zh_cn')).toBe(false)
    expect(isSupportedLocale('zh_tw')).toBe(false)
    expect(isSupportedLocale('fr-FR')).toBe(false)
  })
})
