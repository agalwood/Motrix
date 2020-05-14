<template>
  <div v-if="false"></div>
</template>

<script>
  import { commands } from '@/components/CommandManager/instance'

  export default {
    name: 'mo-ipc',
    methods: {
      bindIpcEvents () {
        this.$electron.ipcRenderer.on('command', (event, command, ...args) => {
          commands.execute(command, ...args)
        })
      },
      unbindIpcEvents () {
        this.$electron.ipcRenderer.removeAllListeners('command')
      }
    },
    created () {
      this.bindIpcEvents()
    },
    destroyed () {
      this.unbindIpcEvents()
    }
  }
</script>
