<template>
  <div id="app">
    <mo-title-bar
      v-if="isRenderer()"
      :showActions="showWindowActions"
    />
    <router-view></router-view>
    <mo-engine-client
      :secret="rpcSecret"
    />
    <mo-ipc v-if="isRenderer()" />
  </div>
</template>

<script>
  import is from 'electron-is'
  import TitleBar from '@/components/Native/TitleBar'
  import EngineClient from '@/components/Native/EngineClient'
  import Ipc from '@/components/Native/Ipc'
  import { mapState } from 'vuex'

  export default {
    name: 'Motrix',
    components: {
      [TitleBar.name]: TitleBar,
      [EngineClient.name]: EngineClient,
      [Ipc.name]: Ipc
    },
    computed: {
      ...mapState('app', {
        systemTheme: state => state.systemTheme
      }),
      ...mapState('preference', {
        showWindowActions: state => {
          return (is.windows() || is.linux()) && state.config.hideAppMenu
        },
        rpcSecret: state => state.config.rpcSecret,
        theme: state => state.config.theme,
        locale: state => state.config.locale
      }),
      themeClass: function () {
        if (this.theme === 'auto') {
          return `theme-${this.systemTheme}`
        } else {
          return `theme-${this.theme}`
        }
      },
      i18nClass: function () {
        return `i18n-${this.locale}`
      }
    },
    methods: {
      isRenderer: is.renderer,
      updateRootClassName: function () {
        const { themeClass = '', i18nClass = '' } = this
        document.documentElement.className = `${themeClass} ${i18nClass}`
      }
    },
    beforeMount: function () {
      this.updateRootClassName()
    },
    watch: {
      themeClass: function (val, oldVal) {
        this.updateRootClassName()
      },
      i18nClass: function (val, oldVal) {
        this.updateRootClassName()
      }
    }
  }
</script>

<style>
</style>
