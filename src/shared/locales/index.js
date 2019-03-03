/**
 * Welcome to translate to more versions in other languages.
 * Please read the translation guide before starting work.
 * https://github.com/agalwood/Motrix/blob/master/CONTRIBUTING.md#-translation-guide
 */
export const availableLanguages = [
  {
    value: 'en-US',
    label: 'English'
  },
  {
    value: 'pt-BR',
    label: 'Português (Brasil)'
  },
  {
    value: 'fr',
    label: 'Français'
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

  if (locale.startsWith('en')) {
    return 'en-US'
  }

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
