import is from 'electron-is'
import Vue from 'vue'
import VueI18Next from '@panter/vue-i18next'
import { sync } from 'vuex-router-sync'
import Element, { Loading, Message } from 'element-ui'
import axios from 'axios'
import 'svg-innerhtml'

import App from './App'
import router from '@/router'
import store from '@/store'
import { getLocaleManager } from '@/components/Locale'
import Icon from '@/components/Icons/Icon'
import Msg from '@/components/Msg'

import '@/components/Theme/Index.scss'

function init (config) {
  if (is.renderer()) {
    Vue.use(require('vue-electron'))
  }

  Vue.http = Vue.prototype.$http = axios
  Vue.config.productionTip = false

  const { locale } = config
  const localeManager = getLocaleManager()
  localeManager.changeLanguageByLocale(locale)

  Vue.use(VueI18Next)
  const i18n = new VueI18Next(localeManager.getI18n())
  Vue.use(Element, {
    size: 'mini',
    i18n: (key, value) => i18n.t(key, value)
  })
  Vue.use(Msg, Message, {
    showClose: true
  })

  const loading = Loading.service({
    fullscreen: true,
    background: 'rgba(0, 0, 0, 0.1)'
  })
  Vue.component('mo-icon', Icon)

  sync(store, router)

  /* eslint-disable no-new */
  window.app = new Vue({
    components: { App },
    router,
    store,
    i18n,
    template: '<App/>'
  }).$mount('#app')

  setTimeout(() => {
    loading.close()
  }, 400)
}

store.dispatch('preference/fetchPreference')
  .then((config) => {
    console.info('[Motrix] fetchPreference===>', config)
    init(config)
  })
  .catch((err) => {
    alert(err)
  })
