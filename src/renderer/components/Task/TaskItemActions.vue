<template>
  <ul :key="task.gid" class="task-item-actions" v-on:dblclick.stop="() => null">
    <li v-for="action in taskActions" :key="action" class="task-item-action">
      <i v-if="action ==='PAUSE'" @click.stop="onPauseClick">
        <mo-icon name="task-pause-line" width="14" height="14" />
      </i>
      <i v-if="action ==='STOP'" @click.stop="onStopClick">
        <mo-icon name="task-stop-line" width="14" height="14" />
      </i>
      <i v-if="action === 'RESUME'" @click.stop="onResumeClick">
        <mo-icon name="task-start-line" width="14" height="14" />
      </i>
      <i v-if="action === 'RESTART'" @click="onRestartClick">
        <mo-icon name="task-restart" width="14" height="14" />
      </i>
      <i v-if="action === 'DELETE'" @click.stop="onDeleteClick">
        <mo-icon name="delete" width="14" height="14" />
      </i>
      <i v-if="action === 'TRASH'" @click.stop="onTrashClick">
        <mo-icon name="trash" width="14" height="14" />
      </i>
      <i v-if="action ==='FOLDER'" @click.stop="onFolderClick">
        <mo-icon name="folder" width="14" height="14" />
      </i>
      <i v-if="action ==='LINK'" @click.stop="onLinkClick">
        <mo-icon name="link" width="14" height="14" />
      </i>
      <i v-if="action ==='INFO'" @click.stop="onInfoClick">
        <mo-icon name="info-circle" width="14" height="14" />
      </i>
      <i v-if="action ==='MORE'" @click.stop="onMoreClick">
        <mo-icon name="more" width="14" height="14" />
      </i>
    </li>
  </ul>
</template>

<script>
  import is from 'electron-is'
  import * as clipboard from 'clipboard-polyfill'
  import '@/components/Icons/task-start-line'
  import '@/components/Icons/task-pause-line'
  import '@/components/Icons/task-stop-line'
  import '@/components/Icons/task-restart'
  import '@/components/Icons/delete'
  import '@/components/Icons/folder'
  import '@/components/Icons/link'
  import '@/components/Icons/info-circle'
  import '@/components/Icons/more'
  import '@/components/Icons/trash'
  import {
    showItemInFolder,
    moveTaskFilesToTrash
  } from '@/components/Native/utils'
  import {
    checkTaskIsSeeder,
    getTaskFullPath,
    getTaskName,
    getTaskUri,
    parseHeader
  } from '@shared/utils'

  const taskActionsMap = {
    active: ['PAUSE', 'DELETE'],
    paused: ['RESUME', 'DELETE'],
    waiting: ['RESUME', 'DELETE'],
    error: ['RESTART', 'TRASH'],
    complete: ['RESTART', 'TRASH'],
    removed: ['RESTART', 'TRASH'],
    seeding: ['STOP', 'DELETE']
  }

  export default {
    name: 'mo-task-item-actions',
    props: {
      mode: {
        type: String,
        default: 'LIST'
      },
      task: {
        type: Object,
        required: true
      }
    },
    computed: {
      taskName () {
        return getTaskName(this.task)
      },
      path () {
        return getTaskFullPath(this.task)
      },
      isSeeder () {
        return checkTaskIsSeeder(this.task)
      },
      taskStatus () {
        const { task, isSeeder } = this
        if (isSeeder) {
          return 'seeding'
        } else {
          return task.status
        }
      },
      taskCommonActions () {
        let result = is.renderer() ? ['FOLDER'] : []
        result = (this.mode === 'LIST')
          ? [...result, 'LINK', 'INFO']
          : [...result, 'LINK']

        return result
      },
      taskActions () {
        const { taskStatus, taskCommonActions } = this
        const actions = taskActionsMap[taskStatus] || []
        const result = [...actions, ...taskCommonActions].reverse()
        return result
      }
    },
    methods: {
      isRenderer: is.renderer,
      deleteTaskFiles (task) {
        moveTaskFilesToTrash(task, {
          pathErrorMsg: this.$t('task.file-path-error'),
          delFailMsg: this.$t('task.remove-task-file-fail'),
          delConfigFailMsg: this.$t('task.remove-task-config-file-fail')
        })
      },
      removeTaskItem (task, isRemoveWithFiles) {
        this.$store.dispatch('task/removeTask', this.task)
          .then(() => {
            if (isRemoveWithFiles) {
              this.deleteTaskFiles(task)
            }
            this.$msg.success(this.$t('task.delete-task-success', {
              taskName: this.taskName
            }))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.delete-task-fail', {
                taskName: this.taskName
              }))
            }
          })
      },
      removeTaskRecord (task, isRemoveWithFiles) {
        this.$store.dispatch('task/removeTaskRecord', this.task)
          .then(() => {
            if (isRemoveWithFiles) {
              this.deleteTaskFiles(task)
            }
            this.$msg.success(this.$t('task.remove-record-success', {
              taskName: this.taskName
            }))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.remove-record-fail', {
                taskName: this.taskName
              }))
            }
          })
      },
      onResumeClick () {
        this.$store.dispatch('task/resumeTask', this.task)
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.resume-task-fail', {
                taskName: this.taskName
              }))
            }
          })
      },
      onRestartClick (event) {
        const { task, taskName } = this
        const { gid, status } = task
        const uri = getTaskUri(task)
        const isNeedShowDialog = status === 'complete' || !!event.altKey
        this.$store.dispatch('task/getTaskOption', gid)
          .then((data) => {
            console.log('getTaskOption===>', data)
            const { dir, header, split } = data
            const options = {
              dir,
              header,
              split,
              out: taskName
            }

            if (isNeedShowDialog) {
              this.showAddTaskDialog(uri, options)
            } else {
              this.directAddTask(uri, options)
              this.$store.dispatch('task/removeTaskRecord', task)
            }
          })
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

        const headers = parseHeader(header)
        const newOptions = {
          ...rest,
          ...headers
        }

        this.$store.dispatch('app/updateAddTaskUrl', uri)
        this.$store.dispatch('app/updateAddTaskOptions', newOptions)
        this.$store.dispatch('app/showAddTaskDialog', 'uri')
      },
      onPauseClick () {
        this.pauseTask()
      },
      onStopClick () {
        this.stopSeeding()
      },
      stopSeeding () {
        if (!this.isSeeder) {
          return
        }
        this.$store.dispatch('task/stopSeeding', this.task)
      },
      pauseTask () {
        const { taskName } = this
        this.$msg.info(this.$t('task.download-pause-message', { taskName }))
        this.$store.dispatch('task/pauseTask', this.task)
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.pause-task-fail', { taskName }))
            }
          })
      },
      onDeleteClick () {
        const self = this
        const { task } = this
        this.$electron.remote.dialog.showMessageBox({
          type: 'warning',
          title: this.$t('task.delete-task'),
          message: this.$t('task.delete-task-confirm', { taskName: this.taskName }),
          buttons: [this.$t('app.yes'), this.$t('app.no')],
          cancelId: 1,
          checkboxLabel: this.$t('task.delete-task-label')
        }, (buttonIndex, checkboxChecked) => {
          if (buttonIndex === 0) {
            self.removeTaskItem(task, checkboxChecked)
          }
        })
      },
      onTrashClick () {
        const self = this
        const { task } = this
        this.$electron.remote.dialog.showMessageBox({
          type: 'warning',
          title: this.$t('task.remove-record'),
          message: this.$t('task.remove-record-confirm', { taskName: this.taskName }),
          buttons: [this.$t('app.yes'), this.$t('app.no')],
          cancelId: 1,
          checkboxLabel: this.$t('task.remove-record-label')
        }, (buttonIndex, checkboxChecked) => {
          if (buttonIndex === 0) {
            self.removeTaskRecord(task, checkboxChecked)
          }
        })
      },
      onFolderClick () {
        showItemInFolder(this.path, {
          errorMsg: this.$t('task.file-not-exist')
        })
      },
      onLinkClick () {
        this.$store.dispatch('app/fetchEngineOptions')
          .then((data) => {
            const { btTracker } = data
            const uri = getTaskUri(this.task, btTracker)
            clipboard.writeText(uri)
              .then(() => {
                this.$msg.success(this.$t('task.copy-link-success'))
              })
          })
      },
      onInfoClick () {
        this.$store.dispatch('task/showTaskItemInfoDialog', this.task)
      },
      onMoreClick () {
        console.log('onMoreClick===>')
      }
    }
  }
</script>

<style lang="scss">
  .task-item-actions {
    // width: 28px;
    height: 24px;
    padding: 0 10px;
    overflow: hidden;
    user-select: none;
    cursor: default;
    text-align: right;
    direction: rtl;
    border: 1px solid $--task-item-action-border-color;
    color: $--task-item-action-color;
    background-color: $--task-item-action-background;
    border-radius: 14px;
    transition: $--all-transition;
    &:hover {
      border-color: $--task-item-action-hover-border-color;
      color: $--task-item-action-hover-color;
      background-color: $--task-item-action-hover-background;
      width: auto;
    }
    &> .task-item-action {
      display: inline-block;
      padding: 5px;
      margin: 0 4px;
      font-size: 0;
      cursor: pointer;
    }
  }
</style>
