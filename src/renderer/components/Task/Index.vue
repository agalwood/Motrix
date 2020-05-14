<template>
  <el-container
    class="content panel"
    direction="horizontal"
  >
    <el-aside
      width="200px"
      class="subnav hidden-xs-only"
    >
      <mo-task-subnav :current="status" />
    </el-aside>
    <el-container
      class="content panel"
      direction="vertical"
    >
      <el-header
        class="panel-header"
        height="84"
      >
        <h4 class="task-title hidden-xs-only">{{ title }}</h4>
        <mo-subnav-switcher
          :title="title"
          :subnavs="subnavs"
          class="hidden-sm-and-up"
        />
        <mo-task-actions />
      </el-header>
      <el-main class="panel-content">
        <mo-task-list />
      </el-main>
    </el-container>
  </el-container>
</template>

<script>
  import { mapState } from 'vuex'
  import * as clipboard from 'clipboard-polyfill'

  import { commands } from '@/components/CommandManager/instance'
  import { ADD_TASK_TYPE } from '@shared/constants'
  import TaskSubnav from '@/components/Subnav/TaskSubnav'
  import TaskActions from '@/components/Task/TaskActions'
  import TaskList from '@/components/Task/TaskList'
  import SubnavSwitcher from '@/components/Subnav/SubnavSwitcher'
  import {
    getTaskUri,
    parseHeader
  } from '@shared/utils'
  import {
    delayDeleteTaskFiles,
    showItemInFolder,
    moveTaskFilesToTrash
  } from '@/utils/native'

  export default {
    name: 'mo-content-task',
    components: {
      [TaskSubnav.name]: TaskSubnav,
      [TaskActions.name]: TaskActions,
      [TaskList.name]: TaskList,
      [SubnavSwitcher.name]: SubnavSwitcher
    },
    props: {
      status: {
        type: String,
        default: 'active'
      }
    },
    computed: {
      ...mapState('task', {
        taskList: state => state.taskList,
        selectedGidList: state => state.selectedGidList,
        selectedGidListCount: state => state.selectedGidList.length
      }),
      ...mapState('preference', {
        noConfirmBeforeDelete: state => state.config.noConfirmBeforeDeleteTask
      }),
      subnavs () {
        return [
          {
            key: 'active',
            title: this.$t('task.active'),
            route: '/task/active'
          },
          {
            key: 'waiting',
            title: this.$t('task.waiting'),
            route: '/task/waiting'
          },
          {
            key: 'stopped',
            title: this.$t('task.stopped'),
            route: '/task/stopped'
          }
        ]
      },
      title () {
        const subnav = this.subnavs.find((item) => item.key === this.status)
        return subnav.title
      }
    },
    watch: {
      status: 'onStatusChange'
    },
    methods: {
      onStatusChange () {
        this.changeCurrentList()
      },
      changeCurrentList () {
        this.$store.dispatch('task/changeCurrentList', this.status)
      },
      directAddTask (uri, options = {}) {
        const uris = [uri]
        const payload = {
          uris,
          options: {
            ...options
          }
        }
        this.$store.dispatch('task/addUri', payload)
          .catch((err) => {
            this.$msg.error(err.message)
          })
      },
      showAddTaskDialog (uri, options = {}) {
        const {
          header,
          ...rest
        } = options
        console.log('showAddTaskDialog.options====>', options)

        const headers = parseHeader(header)
        const newOptions = {
          ...rest,
          ...headers
        }

        this.$store.dispatch('app/updateAddTaskUrl', uri)
        this.$store.dispatch('app/updateAddTaskOptions', newOptions)
        this.$store.dispatch('app/showAddTaskDialog', ADD_TASK_TYPE.URI)
      },
      deleteTaskFiles (task) {
        try {
          const result = moveTaskFilesToTrash(task)

          if (!result) {
            throw new Error('task.remove-task-file-fail')
          }
        } catch (err) {
          this.$msg.error(this.$t(err.message))
        }
      },
      removeTask (task, taskName, isRemoveWithFiles = false) {
        this.$store.dispatch('task/forcePauseTask', task)
          .finally(() => {
            if (isRemoveWithFiles) {
              this.deleteTaskFiles(task)
            }

            return this.removeTaskItem(task, taskName)
          })
      },
      removeTaskRecord (task, taskName, isRemoveWithFiles = false) {
        this.$store.dispatch('task/forcePauseTask', task)
          .finally(() => {
            if (isRemoveWithFiles) {
              this.deleteTaskFiles(task)
            }

            return this.removeTaskRecordItem(task, taskName)
          })
      },
      removeTaskItem (task, taskName) {
        return this.$store.dispatch('task/removeTask', task)
          .then(() => {
            this.$msg.success(this.$t('task.delete-task-success', {
              taskName
            }))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.delete-task-fail', {
                taskName
              }))
            }
          })
      },
      removeTaskRecordItem (task, taskName) {
        return this.$store.dispatch('task/removeTaskRecord', task)
          .then(() => {
            this.$msg.success(this.$t('task.remove-record-success', {
              taskName
            }))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.remove-record-fail', {
                taskName
              }))
            }
          })
      },
      removeTasks (taskList, isRemoveWithFiles = false) {
        const gids = taskList.map((task) => task.gid)
        this.$store.dispatch('task/batchForcePauseTask', gids)
          .finally(() => {
            if (isRemoveWithFiles) {
              this.batchDeleteTaskFiles(taskList)
            }

            this.removeTaskItems(gids)
          })
      },
      batchDeleteTaskFiles (taskList) {
        const promises = taskList.map((task, index) => delayDeleteTaskFiles(task, index * 200))
        Promise.all(promises).then(values => {
          console.log(values)
        })
      },
      removeTaskItems (gids) {
        this.$store.dispatch('task/batchRemoveTask', gids)
          .then(() => {
            this.$msg.success(this.$t('task.batch-delete-task-success'))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.batch-delete-task-fail'))
            }
          })
      },
      handlePauseTask (payload) {
        const { task, taskName } = payload
        this.$msg.info(this.$t('task.download-pause-message', { taskName }))
        this.$store.dispatch('task/pauseTask', task)
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.pause-task-fail', { taskName }))
            }
          })
      },
      handleResumeTask (payload) {
        const { task, taskName } = payload
        this.$store.dispatch('task/resumeTask', task)
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.resume-task-fail', {
                taskName
              }))
            }
          })
      },
      handleStopTaskSeeding (payload) {
        const { task } = payload
        this.$store.dispatch('task/stopSeeding', task)
      },
      handleRestartTask (payload) {
        const { task, taskName, showDialog } = payload
        const { gid } = task
        const uri = getTaskUri(task)

        this.$store.dispatch('task/getTaskOption', gid)
          .then((data) => {
            console.log('[Motrix] get task option:', data)
            const { dir, header, maxConnectionPerServer } = data
            const options = {
              dir,
              header,
              maxConnectionPerServer,
              out: taskName
            }

            if (showDialog) {
              this.showAddTaskDialog(uri, options)
            } else {
              this.directAddTask(uri, options)
              this.$store.dispatch('task/removeTaskRecord', task)
            }
          })
      },
      handleRevealInFolder (payload) {
        const { path } = payload
        showItemInFolder(path, {
          errorMsg: this.$t('task.file-not-exist')
        })
      },
      handleDeleteTask (payload) {
        const { task, taskName, deleteWithFiles } = payload
        const { noConfirmBeforeDelete } = this

        if (noConfirmBeforeDelete) {
          this.removeTask(task, taskName, deleteWithFiles)
          return
        }

        this.$electron.remote.dialog.showMessageBox({
          type: 'warning',
          title: this.$t('task.delete-task'),
          message: this.$t('task.delete-task-confirm', { taskName }),
          buttons: [this.$t('app.yes'), this.$t('app.no')],
          cancelId: 1,
          checkboxLabel: this.$t('task.delete-task-label'),
          checkboxChecked: deleteWithFiles
        }).then(({ response, checkboxChecked }) => {
          if (response === 0) {
            this.removeTask(task, taskName, checkboxChecked)
          }
        })
      },
      handleDeleteTaskRecord (payload) {
        const { task, taskName, deleteWithFiles } = payload
        const { noConfirmBeforeDelete } = this

        if (noConfirmBeforeDelete) {
          this.removeTaskRecord(task, taskName, deleteWithFiles)
          return
        }

        this.$electron.remote.dialog.showMessageBox({
          type: 'warning',
          title: this.$t('task.remove-record'),
          message: this.$t('task.remove-record-confirm', { taskName }),
          buttons: [this.$t('app.yes'), this.$t('app.no')],
          cancelId: 1,
          checkboxLabel: this.$t('task.remove-record-label'),
          checkboxChecked: !!deleteWithFiles
        }).then(({ response, checkboxChecked }) => {
          if (response === 0) {
            this.removeTaskRecord(task, taskName, checkboxChecked)
          }
        })
      },
      handleBatchDeleteTask (payload) {
        const { deleteWithFiles } = payload
        const {
          noConfirmBeforeDelete,
          selectedGidList,
          selectedGidListCount,
          taskList
        } = this
        if (selectedGidListCount === 0) {
          return
        }

        const selectedTaskList = taskList.filter((task) => {
          return selectedGidList.includes(task.gid)
        })

        if (noConfirmBeforeDelete) {
          this.removeTasks(selectedTaskList, deleteWithFiles)
          return
        }

        const count = `${selectedGidListCount}`
        this.$electron.remote.dialog.showMessageBox({
          type: 'warning',
          title: this.$t('task.delete-selected-task'),
          message: this.$t('task.batch-delete-task-confirm', { count }),
          buttons: [this.$t('app.yes'), this.$t('app.no')],
          cancelId: 1,
          checkboxLabel: this.$t('task.delete-task-label'),
          checkboxChecked: deleteWithFiles
        }).then(({ response, checkboxChecked }) => {
          if (response === 0) {
            this.removeTasks(selectedTaskList, checkboxChecked)
          }
        })
      },
      handleCopyTaskLink (payload) {
        const { task } = payload
        const uri = getTaskUri(task)
        clipboard.writeText(uri)
          .then(() => {
            this.$msg.success(this.$t('task.copy-link-success'))
          })
      },
      handleShowTaskInfo (payload) {
        const { task } = payload
        this.$store.dispatch('task/showTaskItemInfoDialog', task)
      }
    },
    created () {
      this.changeCurrentList()
    },
    mounted () {
      commands.on('pause-task', this.handlePauseTask)
      commands.on('resume-task', this.handleResumeTask)
      commands.on('stop-task-seeding', this.handleStopTaskSeeding)
      commands.on('restart-task', this.handleRestartTask)
      commands.on('reveal-in-folder', this.handleRevealInFolder)
      commands.on('delete-task', this.handleDeleteTask)
      commands.on('delete-task-record', this.handleDeleteTaskRecord)
      commands.on('batch-delete-task', this.handleBatchDeleteTask)
      commands.on('copy-task-link', this.handleCopyTaskLink)
      commands.on('show-task-info', this.handleShowTaskInfo)
    },
    destroyed () {
      commands.off('pause-task', this.handlePauseTask)
      commands.off('resume-task', this.handleResumeTask)
      commands.off('stop-task-seeding', this.handleStopTaskSeeding)
      commands.off('restart-task', this.handleRestartTask)
      commands.off('reveal-in-folder', this.handleRevealInFolder)
      commands.off('delete-task', this.handleDeleteTask)
      commands.off('delete-task-record', this.handleDeleteTaskRecord)
      commands.off('batch-delete-task', this.handleBatchDeleteTask)
      commands.off('copy-task-link', this.handleCopyTaskLink)
      commands.off('show-task-info', this.handleShowTaskInfo)
    }
  }
</script>

<style lang="scss">
</style>
