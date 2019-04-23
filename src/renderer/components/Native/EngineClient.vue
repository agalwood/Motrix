<template>
  <div v-if="false"></div>
</template>

<script>
  import is from 'electron-is'
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
    data: function () {
      return {
        downloading: false
      }
    },
    computed: {
      isRenderer: () => is.renderer(),
      ...mapState('app', {
        downloadSpeed: state => state.stat.downloadSpeed,
        interval: state => state.interval,
        numActive: state => state.stat.numActive
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
      },
      numActive: function (val, oldVal) {
        this.downloading = val > 0
      },
      downloading: function (val, oldVal) {
        if (val !== oldVal && this.isRenderer) {
          this.$electron.ipcRenderer.send('download-status-change', val)
        }
      }
    },
    methods: {
      fetchTaskItem ({ gid }) {
        return api.fetchTaskItem({ gid })
          .catch((e) => {
            console.warn(`fetchTaskItem fail: ${e.message}`)
          })
      },
      onDownloadStart: function (event) {
        this.$store.dispatch('task/fetchList')
        this.$store.dispatch('app/resetInterval')
        console.log('aria2 onDownloadStart', event)
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            const taskName = getTaskName(task)
            const message = this.$t('task.download-start-message', { taskName })
            this.$msg.info(message)
          })
      },
      onDownloadPause: function (event) {
        console.log('aria2 onDownloadPause')
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            const taskName = getTaskName(task)
            const message = this.$t('task.download-pause-message', { taskName })
            this.$msg.info(message)
          })
      },
      onDownloadStop: function (event) {
        console.log('aria2 onDownloadStop')
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            const taskName = getTaskName(task)
            const message = this.$t('task.download-stop-message', { taskName })
            this.$msg.info(message)
          })
      },
      onDownloadError: function (event) {
        console.log('aria2 onDownloadError', event)
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            const taskName = getTaskName(task)
            const message = this.$t('task.download-error-message', { taskName })
            this.$msg.error(message)
          })
      },
      onDownloadComplete: function (event) {
        console.log('aria2 onDownloadComplete')
        this.$store.dispatch('task/fetchList')
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            this.handleDownloadComplete(task, false)
          })
      },
      onBtDownloadComplete: function (event) {
        console.log('aria2 onBtDownloadComplete')
        this.$store.dispatch('task/fetchList')
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            this.handleDownloadComplete(task, true)
          })
      },
      handleDownloadComplete: function (task, isBT) {
        const path = getTaskFullPath(task)

        addToRecentTask(task)
        openDownloadDock(path)

        this.showTaskCompleteNotify(task, isBT, path)
      },
      showTaskCompleteNotify: function (task, isBT, path) {
        const taskName = getTaskName(task)
        const message = isBT
          ? this.$t('task.bt-download-complete-message', { taskName })
          : this.$t('task.download-complete-message', { taskName })
        const tips = isBT
          ? '\n' + this.$t('task.bt-download-complete-tips')
          : ''

        this.$msg.success(`${message}${tips}`)

        if (!this.taskNotification) {
          return
        }

        /* eslint-disable no-new */
        const notifyMessage = isBT
          ? this.$t('task.bt-download-complete-notify')
          : this.$t('task.download-complete-notify')

        const notify = new Notification(notifyMessage, {
          body: `${taskName}${tips}`
        })
        notify.onclick = () => {
          showItemInFolder(path, {
            errorMsg: this.$t('task.file-not-exist')
          })
        }
      },
      showTaskErrorNotify: function (task) {
        const taskName = getTaskName(task)

        const message = this.$t('task.download-fail-message', { taskName })
        this.$msg.success(message)

        if (!this.taskNotification) {
          return
        }

        /* eslint-disable no-new */
        new Notification(this.$t('task.download-fail-notify'), {
          body: taskName
        })
      },
      bindEngineEvents: function () {
        api.client.on('onDownloadStart', this.onDownloadStart)
        // api.client.on('onDownloadPause', this.onDownloadPause)
        api.client.on('onDownloadStop', this.onDownloadStop)
        api.client.on('onDownloadComplete', this.onDownloadComplete)
        api.client.on('onDownloadError', this.onDownloadError)
        api.client.on('onBtDownloadComplete', this.onBtDownloadComplete)
      },
      unbindEngineEvents: function () {
        api.client.removeListener('onDownloadStart', this.onDownloadStart)
        // api.client.removeListener('onDownloadPause', this.onDownloadPause)
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
      this.$store.dispatch('app/fetchEngineOptions')

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
