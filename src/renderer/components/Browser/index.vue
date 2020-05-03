<template>
  <div ref="webviewViewport" class="webview-viewport">
    <webview
      class="mo-webview"
      ref="webview"
      :src="src"
    ></webview>
  </div>
</template>

<script>
  import is from 'electron-is'
  import { Loading } from 'element-ui'

  import {
    openExternal
  } from '@/components/Native/utils'

  export default {
    name: 'mo-browser',
    components: {
    },
    props: {
      src: {
        type: String,
        default: ''
      }
    },
    data () {
      return {
        loading: null
      }
    },
    computed: {
      isRenderer: () => is.renderer()
    },
    mounted () {
      const { webview } = this.$refs

      webview.addEventListener('did-start-loading', this.loadStart.bind(this))
      webview.addEventListener('did-stop-loading', this.loadStop.bind(this))
      webview.addEventListener('dom-ready', this.ready.bind(this))
    },
    methods: {
      loadStart () {
        const { webviewViewport } = this.$refs
        this.loading = Loading.service({
          target: webviewViewport
        })
      },
      loadStop () {
        this.$nextTick(() => {
          this.loading.close()
        })
      },
      ready () {
        const { webview } = this.$refs

        const webContents = this.$electron.remote.webContents.fromId(webview.getWebContentsId())
        webContents.on('new-window', (event, url) => {
          event.preventDefault()
          openExternal(url)
        })
      }
    }
  }
</script>

<style lang="scss">
.webview-viewport {
  position: relative;
}
.mo-webview {
  display: inline-flex;;
  flex: 1;
  flex-basis: auto;
}
</style>
