import i18next from 'i18next'
import { getLanguage } from '@shared/locales'

export default class LocaleManager {
  constructor (options = {}) {
    this.options = options

    i18next.init({
      fallbackLng: 'en-US',
      resources: options.resources
    })
  }

  changeLanguage (lng) {
    i18next.changeLanguage(lng)
  }

  changeLanguageByLocale (locale) {
    const lng = getLanguage(locale)
    this.changeLanguage(lng)
  }

  getI18n () {
    return i18next
  }
}
