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
      ...mapState('preference', {
        showWindowActions: state => is.windows() && state.config.hideAppMenu,
        rpcSecret: state => state.config.rpcSecret
      })
    },
    methods: {
      isRenderer: is.renderer
    }
  }
</script>

<style>
</style>
