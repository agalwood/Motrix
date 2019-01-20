import is from 'electron-is'
import Vue from 'vue'
import { sync } from 'vuex-router-sync'
import Element, { Loading } from 'element-ui'
import axios from 'axios'
import 'svg-innerhtml'

import App from './App'
import router from '@/router'
import store from '@/store'
import LocaleManager from '@/components/Locale'

import Icon from '@/components/Icons/Icon'
import '@/components/Theme/Index.scss'

function init (config) {
  if (is.renderer()) {
    Vue.use(require('vue-electron'))
  }

  Vue.http = Vue.prototype.$http = axios
  Vue.config.productionTip = false

  console.log('config.locale==>', config.locale)
  const localeManager = new LocaleManager()
  localeManager.init(config.locale)
  const i18n = localeManager.getI18n()

  Vue.use(Element, {
    size: 'mini',
    i18n: (key, value) => i18n.t(key, value)
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
    console.log('fetchPreference===>', config)
    init(config)
  })
  .catch((err) => {
    alert(err)
  })
