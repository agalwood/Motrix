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
      :src="src"
    />
  </el-container>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'

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
        src: `https://motrix.app/lab?lite=true&lang=${locale}`
      }
    },
    computed: {
      isRenderer: () => is.renderer(),
      title () {
        return this.$t('preferences.lab')
      },
      subnavs: function () {
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
      },
      ...mapState('preference', {
        config: state => state.config
      })
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
  padding: 0 0 0 36px;
}
</style>
