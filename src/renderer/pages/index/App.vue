<template>
  <div id="app">
    <div class="title-bar"></div>
    <router-view></router-view>
    <mo-engine-client
      :secret="rpcSecret"
    />
    <mo-ipc v-if="isRenderer()" />
  </div>
</template>

<script>
  import is from 'electron-is'
  import EngineClient from '@/components/Native/EngineClient'
  import Ipc from '@/components/Native/Ipc'
  import { mapState } from 'vuex'

  export default {
    name: 'Motrix',
    components: {
      [EngineClient.name]: EngineClient,
      [Ipc.name]: Ipc
    },
    computed: {
      ...mapState('preference', {
        rpcSecret: state => state.rpcSecret
      })
    },
    methods: {
      isRenderer: is.renderer
    }
  }
</script>

<style>
</style>
