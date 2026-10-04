import { createInstance } from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureI18nLocale,
  I18N_BACKEND,
  I18N_RESOURCE_LOADERS,
  I18N_RESOURCES,
  loadI18nLocale,
} from './i18n-resources'

afterEach(() => vi.restoreAllMocks())

describe('on-demand bundled translations', () => {
  it('starts with English and Simplified Chinese and resolves a requested locale through the backend', async () => {
    const instance = createInstance().use(I18N_BACKEND)
    await instance.init({
      lng: 'en-US',
      fallbackLng: 'en-US',
      supportedLngs: ['en-US', 'de'],
      resources: { ...I18N_RESOURCES },
      partialBundledLanguages: true,
    })
    expect(instance.hasResourceBundle('de', 'translation')).toBe(false)
    await instance.changeLanguage('de')
    expect(instance.t('common.retry')).toBe('Erneut versuchen')
    expect(Object.keys(I18N_RESOURCES)).toEqual(['en-US', 'zh-CN'])
  })

  it('shares concurrent loads and keeps a failed load retryable', async () => {
    const instance = createInstance()
    await instance.init({ lng: 'en-US', resources: { ...I18N_RESOURCES } })
    const unavailable = new Error('locale chunk unavailable')
    const loader = vi
      .spyOn(I18N_RESOURCE_LOADERS, 'fr')
      .mockRejectedValueOnce(unavailable)
    const first = loadI18nLocale('fr')
    expect(loadI18nLocale('fr')).toBe(first)
    await expect(ensureI18nLocale(instance, 'fr')).rejects.toBe(unavailable)
    expect(instance.hasResourceBundle('fr', 'translation')).toBe(false)
    expect(loader).toHaveBeenCalledOnce()
    await ensureI18nLocale(instance, 'fr')
    expect(loader).toHaveBeenCalledTimes(2)
    expect(instance.getFixedT('fr')('common.retry')).toBe('Réessayer')
  })
})
