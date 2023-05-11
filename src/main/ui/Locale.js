import resources from '@shared/locales/app'
import LocaleManager from '@shared/locales/LocaleManager'

const localeManager = new LocaleManager({
  resources
})

export const getLocaleManager = () => {
  return localeManager
}

export const setupLocaleManager = (locale) => {
  localeManager.changeLanguageByLocale(locale)

  return localeManager
}

export const getI18n = () => {
  return localeManager.getI18n()
}

export const getI18nTranslator = () => {
  return localeManager.getI18n().t
}
