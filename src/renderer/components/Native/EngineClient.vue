<template>
  <div v-if="false"></div>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'
  import api from '@/api'
  import {
    showItemInFolder,
    addToRecentTask
  } from '@/components/Native/utils'
  import {
    bytesToSize,
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
      downloadSpeed (val, oldVal) {
        const speed = val > 0 ? `${bytesToSize(val)}/s` : ''
        this.$electron.ipcRenderer.send('event', 'download-speed-change', speed)
      },
      numActive (val, oldVal) {
        this.downloading = val > 0
      },
      downloading (val, oldVal) {
        if (val !== oldVal && this.isRenderer) {
          this.$electron.ipcRenderer.send('event', 'download-status-change', val)
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
      onDownloadStart (event) {
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
      onDownloadPause (event) {
        console.log('aria2 onDownloadPause')
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            const taskName = getTaskName(task)
            const message = this.$t('task.download-pause-message', { taskName })
            this.$msg.info(message)
          })
      },
      onDownloadStop (event) {
        console.log('aria2 onDownloadStop')
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            const taskName = getTaskName(task)
            const message = this.$t('task.download-stop-message', { taskName })
            this.$msg.info(message)
          })
      },
      onDownloadError (event) {
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            const taskName = getTaskName(task)
            const { errorCode, errorMessage } = task
            console.error(`[Motrix] download error gid: ${gid}, #${errorCode}, ${errorMessage}`)
            const message = this.$t('task.download-error-message', { taskName })
            const link = `<a target="_blank" href="https://github.com/agalwood/Motrix/wiki/Error#${errorCode}" rel="noopener noreferrer">#${errorCode}</a>`
            this.$msg({
              type: 'error',
              showClose: true,
              duration: 5000,
              dangerouslyUseHTMLString: true,
              message: `${message} ${link}`
            })
          })
      },
      onDownloadComplete (event) {
        console.log('aria2 onDownloadComplete')
        this.$store.dispatch('task/fetchList')
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            this.handleDownloadComplete(task, false)
          })
      },
      onBtDownloadComplete (event) {
        console.log('aria2 onBtDownloadComplete')
        this.$store.dispatch('task/fetchList')
        const [{ gid }] = event
        this.fetchTaskItem({ gid })
          .then((task) => {
            this.handleDownloadComplete(task, true)
          })
      },
      handleDownloadComplete (task, isBT) {
        const path = getTaskFullPath(task)

        this.showTaskCompleteNotify(task, isBT, path)

        addToRecentTask(task)

        this.$electron.ipcRenderer.send('event', 'task-download-complete', task, path)
      },
      showTaskCompleteNotify (task, isBT, path) {
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

        const notifyMessage = isBT
          ? this.$t('task.bt-download-complete-notify')
          : this.$t('task.download-complete-notify')

        /* eslint-disable no-new */
        const notify = new Notification(notifyMessage, {
          body: `${taskName}${tips}`
        })
        notify.onclick = () => {
          showItemInFolder(path, {
            errorMsg: this.$t('task.file-not-exist')
          })
        }
      },
      showTaskErrorNotify (task) {
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
      bindEngineEvents () {
        api.client.on('onDownloadStart', this.onDownloadStart)
        // api.client.on('onDownloadPause', this.onDownloadPause)
        api.client.on('onDownloadStop', this.onDownloadStop)
        api.client.on('onDownloadComplete', this.onDownloadComplete)
        api.client.on('onDownloadError', this.onDownloadError)
        api.client.on('onBtDownloadComplete', this.onBtDownloadComplete)
      },
      unbindEngineEvents () {
        api.client.removeListener('onDownloadStart', this.onDownloadStart)
        // api.client.removeListener('onDownloadPause', this.onDownloadPause)
        api.client.removeListener('onDownloadStop', this.onDownloadStop)
        api.client.removeListener('onDownloadComplete', this.onDownloadComplete)
        api.client.removeListener('onDownloadError', this.onDownloadError)
        api.client.removeListener('onBtDownloadComplete', this.onBtDownloadComplete)
      },
      startPolling () {
        this.timer = setTimeout(() => {
          this.polling()
          this.startPolling()
        }, this.interval)
      },
      polling () {
        this.$store.dispatch('app/fetchGlobalStat')
        this.$store.dispatch('task/fetchList')

        if (this.taskItemInfoVisible && this.currentTaskItem) {
          this.$store.dispatch('task/fetchItem', this.currentTaskItem.gid)
        }
      },
      stopPolling () {
        clearTimeout(this.timer)
        this.timer = null
      }
    },
    created () {
      this.bindEngineEvents()
    },
    mounted () {
      setTimeout(() => {
        this.$store.dispatch('app/fetchEngineInfo')
        this.$store.dispatch('app/fetchEngineOptions')

        this.startPolling()
      }, 100)
    },
    destroyed () {
      this.$store.dispatch('task/saveSession')

      this.unbindEngineEvents()

      this.stopPolling()
    }
  }
</script>
