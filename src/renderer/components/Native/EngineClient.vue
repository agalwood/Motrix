<template>
  <div v-if="false"></div>
</template>

<script>
  import { mapState } from 'vuex'
  import api from '@/api'
  import {
    showItemInFolder,
    addToRecentTask,
    openDownloadDock,
    showDownloadSpeedInDock
  } from '@/components/Native/utils'
  import {
    getTaskName,
    getTaskFullPath
  } from '@shared/utils'

  export default {
    name: 'mo-engine-client',
    computed: {
      ...mapState('app', {
        downloadSpeed: state => state.stat.downloadSpeed,
        interval: state => state.interval
      }),
      ...mapState('task', {
        taskItemInfoVisible: state => state.taskItemInfoVisible,
        currentTaskItem: state => state.currentTaskItem
      }),
      ...mapState('preference', {
        taskNotification: state => state.config.taskNotification
      })
    },
    watch: {
      downloadSpeed: function (val, oldVal) {
        showDownloadSpeedInDock(val)
      }
    },
    methods: {
      onDownloadStart: function (event) {
        this.$store.dispatch('task/fetchList')
        this.$store.dispatch('app/resetInterval')
        console.log('aria2 onDownloadStart', event)
        const [{ gid }] = event
        api.fetchTaskItem({ gid })
          .then((task) => {
            const message = `开始下载 ${getTaskName(task)}`
            this.$message.info(message)
          })
      },
      onDownloadPause: function (event) {
        console.log('aria2 onDownloadPause')
        const [{ gid }] = event
        api.fetchTaskItem({ gid })
          .then((task) => {
            const message = `暂停下载 ${getTaskName(task)}`
            this.$message.info(message)
          })
      },
      onDownloadStop: function (event) {
        console.log('aria2 onDownloadStop')
        const [{ gid }] = event
        api.fetchTaskItem({ gid })
          .then((task) => {
            const message = `${getTaskName(task)} 下载中止`
            this.$message.info(message)
          })
      },
      onDownloadError: function (event) {
        console.log('aria2 onDownloadError', event)
        const [{ gid }] = event
        api.fetchTaskItem({ gid })
          .then((task) => {
            const message = `${getTaskName(task)} 下载发生错误`
            this.$message.error(message)
          })
      },
      onDownloadComplete: function (event) {
        console.log('aria2 onDownloadComplete')
        this.$store.dispatch('task/fetchList')
        const [{ gid }] = event
        api.fetchTaskItem({ gid })
          .then((task) => {
            this.showTaskCompleteNotify(task)
          })
      },
      onBtDownloadComplete: function (event) {
        console.log('aria2 onBtDownloadComplete')
        this.$store.dispatch('task/fetchList')
        const [{ gid }] = event
        api.fetchTaskItem({ gid })
          .then((task) => {
            this.showTaskCompleteNotify(task)
          })
      },
      showTaskCompleteNotify: function (task) {
        if (!this.taskNotification) {
          return
        }

        const taskName = getTaskName(task)
        const path = getTaskFullPath(task)

        addToRecentTask(task)
        openDownloadDock(path)

        const message = `${taskName} 下载完成`
        this.$message.success(message)

        /* eslint-disable no-new */
        const notify = new Notification('下载完成', {
          body: taskName
        })
        notify.onclick = () => {
          showItemInFolder(path)
        }
      },
      showTaskErrorNotify: function (task) {
        if (!this.taskNotification) {
          return
        }

        const taskName = getTaskName(task)

        const message = `${taskName} 下载失败`
        this.$message.success(message)

        /* eslint-disable no-new */
        new Notification('下载失败', {
          body: taskName
        })
      },
      bindEngineEvents: function () {
        api.client.on('onDownloadStart', this.onDownloadStart)
        api.client.on('onDownloadPause', this.onDownloadPause)
        api.client.on('onDownloadStop', this.onDownloadStop)
        api.client.on('onDownloadComplete', this.onDownloadComplete)
        api.client.on('onDownloadError', this.onDownloadError)
        api.client.on('onBtDownloadComplete', this.onBtDownloadComplete)
      },
      unbindEngineEvents: function () {
        api.client.removeListener('onDownloadStart', this.onDownloadStart)
        api.client.removeListener('onDownloadPause', this.onDownloadPause)
        api.client.removeListener('onDownloadStop', this.onDownloadStop)
        api.client.removeListener('onDownloadComplete', this.onDownloadComplete)
        api.client.removeListener('onDownloadError', this.onDownloadError)
        api.client.removeListener('onBtDownloadComplete', this.onBtDownloadComplete)
      },
      startPolling: function () {
        this.timer = setTimeout(() => {
          this.polling()
          this.startPolling()
        }, this.interval)
      },
      polling: function () {
        this.$store.dispatch('app/fetchGlobalStat')
        this.$store.dispatch('task/fetchList')
        if (this.taskItemInfoVisible && this.currentTaskItem) {
          this.$store.dispatch('task/fetchItem', this.currentTaskItem.gid)
        }
      },
      stopPolling: function () {
        clearTimeout(this.timer)
        this.timer = null
      }
    },
    created: function () {
      this.$store.dispatch('app/fetchEngineInfo')

      this.startPolling()

      this.bindEngineEvents()
    },
    destroyed: function () {
      this.$store.dispatch('task/saveSession')

      this.unbindEngineEvents()

      this.stopPolling()
    }
  }
</script>
