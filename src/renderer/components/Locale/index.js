import Vue from 'vue'
import i18next from 'i18next'
import VueI18Next from '@panter/vue-i18next'
import { determineLocale } from '@shared/utils'
import resources from './resources'

Vue.use(VueI18Next)

export default class LocaleManager {
  constructor (options = {}) {
    this.options = options

    this.i18n = null
  }

  init (locale) {
    const lng = determineLocale(locale)
    i18next.init({
      lng,
      resources
    })

    this.i18n = new VueI18Next(i18next)
  }

  getI18n () {
    return this.i18n
  }
}
