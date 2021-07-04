/**
 * Welcome to translate to more versions in other languages.
 * Please read the translation guide before starting work.
 * https://github.com/agalwood/Motrix/blob/master/CONTRIBUTING.md#-translation-guide
 *
 * Please keep the locale key in alphabetical order.
 */
export const availableLanguages = [
  {
    value: 'ar',
    label: 'عربي'
  },
  {
    value: 'bg',
    label: 'Българският език'
  },
  {
    value: 'ca',
    label: 'Català'
  },
  {
    value: 'de',
    label: 'Deutsch'
  },
  {
    value: 'el',
    label: 'Ελληνικά'
  },
  {
    value: 'en-US',
    label: 'English'
  },
  {
    value: 'es',
    label: 'Español'
  },
  {
    value: 'fa',
    label: 'فارسی'
  },
  {
    value: 'fr',
    label: 'Français'
  },
  {
    value: 'hu',
    label: 'Hungarian'
  },
  {
    value: 'id',
    label: 'Indonesia'
  },
  {
    value: 'it',
    label: 'Italiano'
  },
  {
    value: 'ja',
    label: '日本語'
  },
  {
    value: 'ko',
    label: '한국어'
  },
  {
    value: 'nb',
    label: 'Norsk Bokmål'
  },
  {
    value: 'pl',
    label: 'Polski'
  },
  {
    value: 'pt-BR',
    label: 'Português (Brasil)'
  },
  {
    value: 'ro',
    label: 'Română'
  },
  {
    value: 'ru',
    label: 'Русский'
  },
  {
    value: 'tr',
    label: 'Türkçe'
  },
  {
    value: 'uk',
    label: 'Українська'
  },
  {
    value: 'vi',
    label: 'Tiếng Việt'
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
  return availableLanguages.some(lng => lng.value === locale)
}

/**
 * getLanguage
 * @param { String } locale
 * https://www.electronjs.org/docs/api/app#appgetlocale
 *
 * Only these locales need to add a `startsWith` fallback
 * when there are with the same prefix
 *
 * ar, ar-XB
 * de, de-AT, de-CH, de-DE
 * en, en-AU, en-CA, en-GB, en-IN, en-NZ, en-US, en-XA, en-ZA
 * es, es-419, es-AR, es-CL, es-CO, es-CR, es-ES, es-HN, es-MX, es-PE, es-US, es-UY, es-VE
 * fr, fr-CA, fr-CH, fr-FR
 * it, it-CH, it-IT
 * pt, pt-BR, pt-PT
 * zh, zh-CN, zh-HK, zh-TW
 */
export function getLanguage (locale = 'en-US') {
  if (checkLngIsAvailable(locale)) {
    return locale
  }

  if (locale.startsWith('ar')) {
    return 'ar'
  }

  if (locale.startsWith('de')) {
    return 'de'
  }

  if (locale.startsWith('en')) {
    return 'en-US'
  }

  if (locale.startsWith('es')) {
    return 'es'
  }

  if (locale.startsWith('fr')) {
    return 'fr'
  }

  if (locale.startsWith('it')) {
    return 'it'
  }

  // If there is a pt-PT translation in the future,
  // here will fallback to pt-PT.
  if (locale.startsWith('pt')) {
    return 'pt-BR'
  }

  if (locale === 'zh-HK') {
    return 'zh-TW'
  }

  if (locale.startsWith('zh')) {
    return 'zh-CN'
  }
}
