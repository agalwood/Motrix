import Vue from 'vue'
import axios from 'axios'

import App from './App'
import { sync } from 'vuex-router-sync'
import router from '@/router'
import store from '@/store'

import Element, { Loading } from 'element-ui'
import '../../components/Theme/Index.scss'

import Icon from '../../components/Icons/Icon'
import 'svg-innerhtml'

import is from 'electron-is'
if (is.renderer()) {
  Vue.use(require('vue-electron'))
}

Vue.http = Vue.prototype.$http = axios
Vue.config.productionTip = false

Vue.use(Element, { size: 'mini' })
Vue.component('mo-icon', Icon)

sync(store, router)

const loading = Loading.service({
  fullscreen: true,
  background: 'rgba(0, 0, 0, 0.1)'
})

store.dispatch('preference/fetchPreference')
  .then(() => {
    /* eslint-disable no-new */
    window.app = new Vue({
      components: { App },
      router,
      store,
      template: '<App/>'
    }).$mount('#app')
    setTimeout(() => {
      loading.close()
    }, 400)
  })
  .catch((err) => {
    alert(err)
  })
