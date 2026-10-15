import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n, initI18n, resolveDefaultLocale } from '@/shared/i18n'
import { SUPPORTED_LOCALES } from '@/shared/supportedLocales'

declare const browser: {
  i18n: { getUILanguage: () => string }
  storage: {
    local: {
      get: (k: string) => Promise<Record<string, unknown>>
      set: (i: Record<string, unknown>) => Promise<void>
      remove: (k: string) => Promise<void>
    }
  }
}

beforeEach(() => {
  let bag: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string) =>
    k in bag ? { [k]: bag[k] } : {}
  )
  browser.storage.local.set = vi.fn(async (i: Record<string, unknown>) => {
    bag = { ...bag, ...i }
  })
  browser.storage.local.remove = vi.fn(async (k: string) => {
    delete bag[k]
  })
  browser.i18n = { getUILanguage: vi.fn(() => 'en-US') }
})

describe('resolveDefaultLocale', () => {
  it.each([
    ['zh', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-MO', 'zh-TW'],
    ['zh-Hant', 'zh-TW'],
    ['zh-Hant-CN', 'zh-TW'],
    ['zh-Hans-TW', 'zh-CN'],
    ['ZH_tw', 'zh-TW'],
    ['pt_BR', 'pt-BR'],
    ['pt-PT', 'pt-BR'],
    ['pt', 'pt-BR'],
    ['de-DE', 'de'],
    ['es-MX', 'es'],
    ['fr-CA', 'fr'],
    ['hi-IN', 'hi'],
    ['id-ID', 'id'],
    ['it-IT', 'it'],
    ['ja-JP', 'ja'],
    ['ko-KR', 'ko'],
    ['ru-RU', 'ru'],
    ['th-TH', 'th'],
    ['tr-TR', 'tr'],
    ['vi-VN', 'vi'],
    ['en', 'en-US'],
    ['en-GB', 'en-US'],
    ['ar', 'ar'],
    ['bg', 'bg'],
    ['ca', 'ca'],
    ['el', 'el'],
    ['fa', 'fa'],
    ['hu', 'hu'],
    ['nb', 'nb'],
    ['nl', 'nl'],
    ['pl', 'pl'],
    ['ro', 'ro'],
    ['uk', 'uk'],
    ['ar-SA', 'ar'],
    ['fa-IR', 'fa'],
    ['bg-BG', 'bg'],
    ['ca-ES', 'ca'],
    ['el-GR', 'el'],
    ['hu-HU', 'hu'],
    ['nb-NO', 'nb'],
    ['no', 'nb'],
    ['no-NO', 'nb'],
    ['nl-BE', 'nl'],
    ['pl-PL', 'pl'],
    ['ro-RO', 'ro'],
    ['uk-UA', 'uk'],
    ['sv-SE', 'en-US'],
    ['', 'en-US'],
  ])('maps %s to %s', (language, expected) => {
    browser.i18n.getUILanguage = () => language
    expect(resolveDefaultLocale()).toBe(expected)
  })
})

describe('initI18n', () => {
  it('uses the browser default when no override stored', async () => {
    browser.i18n.getUILanguage = () => 'zh-CN'
    await initI18n()
    expect(i18n.language).toBe('zh-CN')
    expect(i18n.t('contextMenu.downloadWithMotrix')).toBe('用 Motrix 下载')
  })
  it('honors a stored override over the browser language', async () => {
    browser.i18n.getUILanguage = () => 'zh-CN'
    await browser.storage.local.set({ 'motrix.locale': 'en-US' })
    await initI18n()
    expect(i18n.language).toBe('en-US')
    expect(i18n.t('contextMenu.downloadWithMotrix')).toBe(
      'Download with Motrix'
    )
  })
})

describe('registered translations', () => {
  it.each(SUPPORTED_LOCALES)(
    'loads %s without English fallback',
    async (locale) => {
      await browser.storage.local.set({ 'motrix.locale': locale })
      await initI18n()
      expect(i18n.language).toBe(locale)
      expect(i18n.hasResourceBundle(locale, 'translation')).toBe(true)
      const translated = i18n.t('contextMenu.downloadWithMotrix', {
        fallbackLng: false,
      })
      expect(translated).not.toBe('contextMenu.downloadWithMotrix')
      if (locale !== 'en-US')
        expect(translated).not.toBe('Download with Motrix')
    }
  )
})
