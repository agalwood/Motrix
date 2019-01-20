import Vue from 'vue'
import i18next from 'i18next'
import VueI18Next from '@panter/vue-i18next'
import { getLanguage } from '@shared/locales'
import resources from '@shared/locales/all'

Vue.use(VueI18Next)

export default class LocaleManager {
  constructor (options = {}) {
    this.options = options

    this.i18n = null
  }

  init (locale) {
    const lng = getLanguage(locale)
    i18next.init({
      fallbackLng: 'en-US',
      lng,
      resources
    })

    this.i18n = new VueI18Next(i18next)
  }

  getI18n () {
    return this.i18n
  }
}
