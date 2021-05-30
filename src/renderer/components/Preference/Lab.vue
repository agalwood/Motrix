<template>
  <el-container class="content panel" direction="vertical">
    <el-header class="panel-header" height="84">
      <h4 class="hidden-xs-only">{{ title }}</h4>
      <mo-subnav-switcher
        :title="title"
        :subnavs="subnavs"
        class="hidden-sm-and-up"
      />
    </el-header>
    <mo-browser
      v-if="isRenderer"
      class="lab-webview"
      :src="url"
    />
  </el-container>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'

  import { APP_THEME } from '@shared/constants'
  import SubnavSwitcher from '@/components/Subnav/SubnavSwitcher'
  import Browser from '@/components/Browser'
  import '@/components/Icons/info-square'

  export default {
    name: 'mo-preference-lab',
    components: {
      [SubnavSwitcher.name]: SubnavSwitcher,
      [Browser.name]: Browser
    },
    data () {
      const { locale } = this.$store.state.preference.config
      return {
        locale
      }
    },
    computed: {
      isRenderer: () => is.renderer(),
      ...mapState('app', {
        systemTheme: state => state.systemTheme
      }),
      ...mapState('preference', {
        config: state => state.config,
        theme: state => state.config.theme
      }),
      currentTheme () {
        if (this.theme === APP_THEME.AUTO) {
          return this.systemTheme
        } else {
          return this.theme
        }
      },
      url () {
        const { currentTheme, locale } = this
        const result = `https://motrix.app/lab?lite=true&theme=${currentTheme}&lang=${locale}`
        return result
      },
      title () {
        return this.$t('preferences.lab')
      },
      subnavs () {
        return [
          {
            key: 'basic',
            title: this.$t('preferences.basic'),
            route: '/preference/basic'
          },
          {
            key: 'advanced',
            title: this.$t('preferences.advanced'),
            route: '/preference/advanced'
          },
          {
            key: 'lab',
            title: this.$t('preferences.lab'),
            route: '/preference/lab'
          }
        ]
      }
    }
  }
</script>

<style lang="scss">
.lab-webview {
  display: inline-flex;;
  flex: 1;
  flex-basis: auto;
  overflow: auto;
  box-sizing: border-box;
  padding: 0;
}
</style>
