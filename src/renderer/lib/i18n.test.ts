import '@testing-library/jest-dom/vitest'
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  SUPPORTED_LOCALE_CODES,
  SUPPORTED_LOCALES,
} from '@shared/constants/locales'
import { I18N_RESOURCE_LOADERS } from '@shared/i18n-resources'
import { describe, expect, it, vi } from 'vitest'
import { applyDocumentLocaleMetadata, applyRendererLocale, i18n } from './i18n'

describe('renderer i18n', () => {
  it('keeps a newer language selection when an earlier chunk finishes late', async () => {
    let finish!: (
      value: Awaited<ReturnType<typeof I18N_RESOURCE_LOADERS.ar>>
    ) => void
    const original = I18N_RESOURCE_LOADERS.ar
    const loader = vi.spyOn(I18N_RESOURCE_LOADERS, 'ar').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    try {
      const older = applyRendererLocale('ar')
      await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce())
      await applyRendererLocale('en-US')
      finish(await original())
      await older
      expect(i18n.resolvedLanguage).toBe('en-US')
      expect(document.documentElement).toHaveAttribute('lang', 'en-US')
      expect(document.documentElement).toHaveAttribute('dir', 'ltr')
    } finally {
      loader.mockRestore()
    }
  })

  it('derives supported and fallback locales from the shared catalog', () => {
    expect(i18n.options.supportedLngs).toEqual(
      expect.arrayContaining([...SUPPORTED_LOCALE_CODES])
    )
    expect(i18n.options.fallbackLng).toEqual([FALLBACK_LOCALE])
  })

  it.each(SUPPORTED_LOCALES)(
    'applies $code to i18next and the document root',
    async ({ code, dir }) => {
      await applyRendererLocale(code)

      expect(i18n.resolvedLanguage).toBe(code)
      expect(document.documentElement).toHaveAttribute('lang', code)
      expect(document.documentElement).toHaveAttribute('dir', dir)
    }
  )

  it('falls back safely for an unavailable locale', async () => {
    await expect(applyRendererLocale('not-a-locale')).resolves.toBe(
      DEFAULT_LOCALE
    )
  })

  it('applies RTL catalog metadata to the document root', () => {
    applyDocumentLocaleMetadata({ code: 'ar-SA', dir: 'rtl' })

    expect(document.documentElement).toHaveAttribute('lang', 'ar-SA')
    expect(document.documentElement).toHaveAttribute('dir', 'rtl')
  })
})
