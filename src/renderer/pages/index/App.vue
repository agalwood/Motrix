<template>
  <div id="app">
    <mo-title-bar
      v-if="isRenderer"
      :showActions="showWindowActions"
    />
    <router-view />
    <mo-engine-client
      :secret="rpcSecret"
    />
    <mo-ipc v-if="isRenderer" />
  </div>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'
  import { getLangDirection } from '@shared/utils'
  import { APP_THEME } from '@shared/constants'
  import TitleBar from '@/components/Native/TitleBar'
  import EngineClient from '@/components/Native/EngineClient'
  import Ipc from '@/components/Native/Ipc'

  export default {
    name: 'Motrix',
    components: {
      [TitleBar.name]: TitleBar,
      [EngineClient.name]: EngineClient,
      [Ipc.name]: Ipc
    },
    computed: {
      isRenderer: () => is.renderer(),
      ...mapState('app', {
        systemTheme: state => state.systemTheme
      }),
      ...mapState('preference', {
        showWindowActions: state => {
          return (is.windows() || is.linux()) && state.config.hideAppMenu
        },
        rpcSecret: state => state.config.rpcSecret,
        theme: state => state.config.theme,
        locale: state => state.config.locale,
        dir: state => getLangDirection(state.config.locale)
      }),
      themeClass () {
        if (this.theme === APP_THEME.AUTO) {
          return `theme-${this.systemTheme}`
        } else {
          return `theme-${this.theme}`
        }
      },
      i18nClass () {
        return `i18n-${this.locale}`
      },
      dirClass () {
        return `dir-${this.dir}`
      }
    },
    methods: {
      updateRootClassName () {
        const { themeClass = '', i18nClass = '', dirClass = '' } = this
        const className = `${themeClass} ${i18nClass} ${dirClass}`
        document.documentElement.className = className
      }
    },
    beforeMount () {
      this.updateRootClassName()
    },
    watch: {
      themeClass (val, oldVal) {
        this.updateRootClassName()
      },
      i18nClass (val, oldVal) {
        this.updateRootClassName()
      },
      dirClass (val, oldVal) {
        this.updateRootClassName()
      }
    }
  }
</script>

<style>
</style>
