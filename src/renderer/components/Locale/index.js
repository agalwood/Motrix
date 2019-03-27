import resources from '@shared/locales/all'
import LocaleManager from '@shared/locales/LocaleManager'

const localeManager = new LocaleManager({
  resources
})

export function getLocaleManager () {
  return localeManager
}
