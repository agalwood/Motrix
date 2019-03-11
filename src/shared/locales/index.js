/**
 * Welcome to translate to more versions in other languages.
 * Please read the translation guide before starting work.
 * https://github.com/agalwood/Motrix/blob/master/CONTRIBUTING.md#-translation-guide
 *
 * Please keep the locale key in alphabetical order.
 */
export const availableLanguages = [
  {
    value: 'de',
    label: 'Deutsch'
  },
  {
    value: 'en-US',
    label: 'English'
  },
  {
    value: 'fr',
    label: 'Français'
  },
  {
    value: 'pt-BR',
    label: 'Português (Brasil)'
  },
  {
    value: 'tr',
    label: 'Türkçe'
  },
  {
    value: 'zh-CN',
    label: '简体中文'
  },
  {
    value: 'zh-TW',
    label: '繁體中文'
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

  if (locale.startsWith('de')) {
    return 'de'
  }

  if (locale.startsWith('en')) {
    return 'en-US'
  }

  // If there is a pt-PT translation in the future,
  // here will fallback to pt-PT.
  if (locale.startsWith('pt')) {
    return 'pt-BR'
  }

  if (locale.startsWith('zh')) {
    return 'zh-CN'
  }

  if (locale.startsWith('fr')) {
    return 'fr'
  }
}
