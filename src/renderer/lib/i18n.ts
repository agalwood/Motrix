import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  getLocaleDefinition,
  type LocaleDefinition,
  resolveSupportedLocale,
  SUPPORTED_LOCALE_CODES,
  type SupportedLocale,
} from '@shared/constants/locales'
import {
  ensureI18nLocale,
  I18N_BACKEND,
  I18N_RESOURCES,
} from '@shared/i18n-resources'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const i18nReady = i18n
  .use(I18N_BACKEND)
  .use(initReactI18next)
  .init({
    resources: { ...I18N_RESOURCES },
    partialBundledLanguages: true,
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

let localeRequest = 0

export async function applyRendererLocale(
  locale: string | null | undefined
): Promise<SupportedLocale> {
  const request = ++localeRequest
  const resolved = resolveSupportedLocale(locale)
  await i18nReady
  await ensureI18nLocale(i18n, resolved)
  if (request !== localeRequest) return resolved
  await i18n.changeLanguage(resolved)
  if (request !== localeRequest) return resolved

  applyDocumentLocaleMetadata(getLocaleDefinition(resolved))

  return resolved
}

export { i18n }
