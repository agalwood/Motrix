import {
  isSupportedLocale,
  type SupportedLocale,
} from '@shared/constants/locales'
import enUS from '@shared/locales/en-US.json'
import zhCN from '@shared/locales/zh-CN.json'
import type { BackendModule, i18n } from 'i18next'

// Keep English and Simplified Chinese synchronous; other bundled locales load on demand.
export const I18N_RESOURCES = {
  'en-US': { translation: enUS },
  'zh-CN': { translation: zhCN },
}

export const I18N_RESOURCE_LOADERS = {
  ar: () => import('@shared/locales/ar.json'),
  bg: () => import('@shared/locales/bg.json'),
  ca: () => import('@shared/locales/ca.json'),
  de: () => import('@shared/locales/de.json'),
  el: () => import('@shared/locales/el.json'),
  'en-US': async () => ({ default: enUS }),
  es: () => import('@shared/locales/es.json'),
  fa: () => import('@shared/locales/fa.json'),
  fr: () => import('@shared/locales/fr.json'),
  hu: () => import('@shared/locales/hu.json'),
  id: () => import('@shared/locales/id.json'),
  it: () => import('@shared/locales/it.json'),
  ja: () => import('@shared/locales/ja.json'),
  ko: () => import('@shared/locales/ko.json'),
  nb: () => import('@shared/locales/nb.json'),
  nl: () => import('@shared/locales/nl.json'),
  pl: () => import('@shared/locales/pl.json'),
  'pt-BR': () => import('@shared/locales/pt-BR.json'),
  ro: () => import('@shared/locales/ro.json'),
  ru: () => import('@shared/locales/ru.json'),
  th: () => import('@shared/locales/th.json'),
  tr: () => import('@shared/locales/tr.json'),
  uk: () => import('@shared/locales/uk.json'),
  vi: () => import('@shared/locales/vi.json'),
  'zh-CN': async () => ({ default: zhCN }),
  'zh-TW': () => import('@shared/locales/zh-TW.json'),
} satisfies Record<
  SupportedLocale,
  () => Promise<{ default: Record<string, unknown> }>
>

const pending = new Map<SupportedLocale, Promise<Record<string, unknown>>>()

export function loadI18nLocale(
  locale: SupportedLocale
): Promise<Record<string, unknown>> {
  const existing = pending.get(locale)
  if (existing) return existing
  const next = I18N_RESOURCE_LOADERS[locale]()
    .then((module) => module.default)
    .catch((error) => {
      pending.delete(locale)
      throw error
    })
  pending.set(locale, next)
  return next
}

export async function ensureI18nLocale(
  instance: i18n,
  locale: SupportedLocale
): Promise<void> {
  if (instance.hasResourceBundle(locale, 'translation')) return
  const translation = await loadI18nLocale(locale)
  instance.addResourceBundle(locale, 'translation', translation)
}

// Also supports i18next consumers that call changeLanguage directly.
export const I18N_BACKEND: BackendModule = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    if (!isSupportedLocale(language) || namespace !== 'translation') {
      callback(
        new Error(`Unsupported translation resource: ${language}/${namespace}`),
        false
      )
      return
    }
    void loadI18nLocale(language).then(
      (translation) => callback(null, translation),
      (error: unknown) =>
        callback(
          error instanceof Error ? error : new Error(String(error)),
          false
        )
    )
  },
}
