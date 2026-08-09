import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  getLocaleDefinition,
  type LocaleDefinition,
  resolveSupportedLocale,
  SUPPORTED_LOCALE_CODES,
  type SupportedLocale,
} from '@shared/constants/locales'
import { I18N_RESOURCES } from '@shared/i18n-resources'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const i18nReady = i18n.use(initReactI18next).init({
  resources: I18N_RESOURCES,
  supportedLngs: SUPPORTED_LOCALE_CODES,
  lng: DEFAULT_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  interpolation: {
    escapeValue: false,
  },
})

export function applyDocumentLocaleMetadata(
  locale: Pick<LocaleDefinition, 'code' | 'dir'>
): void {
  if (typeof document === 'undefined') return

  document.documentElement.lang = locale.code
  document.documentElement.dir = locale.dir
}

export async function applyRendererLocale(
  locale: string | null | undefined
): Promise<SupportedLocale> {
  const resolved = resolveSupportedLocale(locale)
  await i18nReady
  await i18n.changeLanguage(resolved)

  applyDocumentLocaleMetadata(getLocaleDefinition(resolved))

  return resolved
}

export { i18n }
