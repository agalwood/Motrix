import i18next from 'i18next'
import { getLanguage } from '@shared/locales'
import resources from '@shared/locales/all'

export class LocaleManager {
  constructor (options = {}) {
    this.options = options

    i18next.init({
      fallbackLng: 'en-US',
      resources
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

const localeManager = new LocaleManager()
export function getLocaleManager () {
  return localeManager
}
