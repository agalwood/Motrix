import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  SUPPORTED_LOCALE_CODES,
  type SupportedLocale,
} from '@shared/constants/locales'
import {
  ensureI18nLocale,
  I18N_BACKEND,
  I18N_RESOURCES,
} from '@shared/i18n-resources'
import i18n from 'i18next'

const ready = i18n.use(I18N_BACKEND).init({
  resources: { ...I18N_RESOURCES },
  partialBundledLanguages: true,
  supportedLngs: SUPPORTED_LOCALE_CODES,
  lng: DEFAULT_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  interpolation: {
    escapeValue: false,
  },
})

export async function applyMainLocale(locale: SupportedLocale): Promise<void> {
  await ready
  await ensureI18nLocale(i18n, locale)
  await i18n.changeLanguage(locale)
}

export { i18n }
