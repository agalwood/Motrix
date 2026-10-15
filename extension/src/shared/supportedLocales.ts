/** Canonical BCP 47 tags shared by storage, settings, and i18next. */
export const SUPPORTED_LOCALES = [
  'ar',
  'bg',
  'ca',
  'de',
  'el',
  'en-US',
  'es',
  'fa',
  'fr',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'nb',
  'nl',
  'pl',
  'pt-BR',
  'ro',
  'ru',
  'th',
  'tr',
  'uk',
  'vi',
  'zh-CN',
  'zh-TW',
] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_NAMES: Record<SupportedLocale, string> = {
  ar: 'العربية',
  bg: 'Български',
  ca: 'Català',
  el: 'Ελληνικά',
  fa: 'فارسی',
  hu: 'Magyar',
  nb: 'Norsk bokmål',
  nl: 'Nederlands',
  pl: 'Polski',
  ro: 'Română',
  uk: 'Українська',
  'en-US': 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  th: 'ไทย',
  tr: 'Türkçe',
  vi: 'Tiếng Việt',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return SUPPORTED_LOCALES.some((locale) => locale === value)
}

export function resolveLocale(language: string): SupportedLocale {
  const parts = language.toLowerCase().replaceAll('_', '-').split('-')
  const base = parts[0]
  if (base === 'zh') {
    // An explicit script takes precedence over the region.
    if (parts.includes('hans')) return 'zh-CN'
    if (parts.includes('hant')) return 'zh-TW'
    return parts.some((part) => ['tw', 'hk', 'mo'].includes(part))
      ? 'zh-TW'
      : 'zh-CN'
  }
  if (base === 'no') return 'nb'
  if (base === 'pt') return 'pt-BR'
  if (isSupportedLocale(base)) return base
  return 'en-US'
}
