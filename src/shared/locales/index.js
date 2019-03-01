/**
 * Welcome to translate to more versions in other languages.
 * Please read the translation guide before starting work.
 * https://github.com/agalwood/Motrix/blob/master/CONTRIBUTING.md#-translation-guide
 */
export const availableLanguages = [
  {
    value: 'en-US',
    label: '🇺🇸 English (US)'
  },
  {
    value: 'zh-CN',
    label: '🇨🇳 简体中文'
  },
  {
    value: 'zh-TW',
    label: 'ᴛᴡ 正體中文'
  },
  {
    value: 'tr',
    label: '🇹🇷 Türkçe (TR)'
  },
  {
    value: 'fr',
    label: '🇫🇷 Français (FR)'
  }
]

function checkLngIsAvailable (locale) {
  return availableLanguages.some((lng) => lng.value === locale)
}

/**
 * getLanguage
 * @param { String } locale
 * https://electronjs.org/docs/api/locales
 */
export function getLanguage (locale = 'en-US') {
  if (checkLngIsAvailable(locale)) {
    return locale
  }

  if (locale.startsWith('en')) {
    return 'en-US'
  }

  if (locale.startsWith('zh')) {
    return 'zh-CN'
  }

  if (locale.startsWith('fr')) {
    return 'fr'
  }
}
