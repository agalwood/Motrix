<template>
<div style="display: none;">
  <img
    id="tray-icon-light-normal"
    src="static/mo-tray-light-normal@2x.png"
  >
  <img
    id="tray-icon-light-active"
    src="static/mo-tray-light-active@2x.png"
  >
  <img
    id="tray-icon-dark-normal"
    src="static/mo-tray-dark-normal@2x.png"
  >
  <img
    id="tray-icon-dark-active"
    src="static/mo-tray-dark-active@2x.png"
  >
</div>
</template>

<script>
  import { mapState } from 'vuex'

  import { getInverseTheme } from '@shared/utils'
  import { APP_THEME } from '@shared/constants'

  const cache = {}

  export default {
    name: 'mo-dynamic-tray',
    computed: {
      ...mapState('app', {
        bigSur: state => state.bigSur,
        iconStatus: state => state.stat.numActive > 0 ? 'active' : 'normal',
        theme: state => state.systemTheme,
        focused: state => state.trayFocused,
        uploadSpeed: state => state.stat.uploadSpeed,
        downloadSpeed: state => state.stat.downloadSpeed,
        speed: state => state.stat.uploadSpeed + state.stat.downloadSpeed
      }),
      scale () {
        return 2
      },
      currentTheme () {
        const { theme, focused } = this
        if (theme === APP_THEME.DARK) {
          return theme
        }

        return focused ? getInverseTheme(theme) : theme
      },
      iconKey () {
        const { bigSur, iconStatus, currentTheme } = this
        return bigSur ? 'tray-icon-light-normal' : `tray-icon-${currentTheme}-${iconStatus}`
      }
    },
    watch: {
      async speed (val) {
        await this.drawTray()
      },
      async iconKey (val) {
        await this.drawTray()
      }
    },
    mounted () {
      setTimeout(async () => {
        await this.drawTray()
      }, 200)
    },
    methods: {
      async getIcon (key) {
        if (cache[key]) {
          return cache[key]
        }

        const iconImage = document.getElementById(key)
        const result = await createImageBitmap(iconImage)
        cache[key] = result

        return result
      },
      async drawTray () {
        const {
          currentTheme: theme,
          uploadSpeed,
          downloadSpeed,
          scale,
          iconKey
        } = this
        console.log('currentTheme====>', theme, iconKey)

        const icon = await this.getIcon(iconKey)

        global.app.trayWorker.postMessage({
          type: 'tray:draw',
          payload: {
            theme,
            icon,
            uploadSpeed,
            downloadSpeed,
            scale
          }
        })
      }
    }
  }
</script>
