import resources from '@shared/locales/app'
import LocaleManager from '@shared/locales/LocaleManager'

const localeManager = new LocaleManager({
  resources
})

export function getLocaleManager () {
  return localeManager
}

export function setupLocaleManager (locale) {
  localeManager.changeLanguageByLocale(locale)

  return localeManager
}

export function getI18n () {
  return localeManager.getI18n()
}

export function getI18nTranslator () {
  return localeManager.getI18n().t
}
