/**
 * If you want to contribute translation, please add a 'locale' here.
 * For the value of locale, please refer to the link below.
 * https://electronjs.org/docs/api/locales
 */
export const supportLanguages = [
  'en-US',
  'zh-CN',
  'tr-TR'
]

/**
 * getLanguage
 * @param { String } locale
 * https://electronjs.org/docs/api/locales
 */
export function getLanguage (locale = 'en-US') {
  if (supportLanguages.includes(locale)) {
    return locale
  }

  if (locale.startsWith('en')) {
    return 'en-US'
  }

  if (locale.startsWith('tr')) {
    return 'tr-TR'
  }

  if (locale.startsWith('zh')) {
    return 'zh-CN'
  }
}
