<template>
  <div class="task-item-actions" v-on:dblclick.stop="() => null">
    <!-- <i @click.stop="onMoreClick">
      <mo-icon name="more" width="14" height="14" />
    </i> -->
    <i @click.stop="onInfoClick" v-if="mode === 'LIST'">
      <mo-icon name="info-circle" width="14" height="14" />
    </i>
    <i @click.stop="onLinkClick">
      <mo-icon name="link" width="14" height="14" />
    </i>
    <i v-if="isRenderer()" @click.stop="onFolderClick">
      <mo-icon name="folder" width="14" height="14" />
    </i>
    <i v-if="task.status ==='complete' ||
      task.status ==='removed' ||
      task.status ==='error'"
      @click.stop="onTrashClick">
      <mo-icon name="trash" width="14" height="14" />
    </i>
    <i v-if="task.status ==='active' ||
      task.status ==='waiting' ||
      task.status ==='paused'"
      @click.stop="onDeleteClick">
      <mo-icon name="delete" width="14" height="14" />
    </i>
    <i v-if="task.status ==='active'" @click.stop="onPauseClick">
      <mo-icon name="task-pause-line" width="14" height="14" />
    </i>
    <i v-if="task.status ==='waiting' || task.status ==='paused'" @click.stop="onResumeClick">
      <mo-icon name="task-start-line" width="14" height="14" />
    </i>
  </div>
</template>

<script>
  import is from 'electron-is'
  import clipboard from 'clipboard-polyfill'
  import '@/components/Icons/task-start-line'
  import '@/components/Icons/task-pause-line'
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
    getTaskName,
    getTaskUri,
    getTaskFullPath
  } from '@shared/utils'

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
      taskName: function () {
        return getTaskName(this.task)
      },
      path: function () {
        return getTaskFullPath(this.task)
      }
    },
    methods: {
      isRenderer: is.renderer,
      deleteTaskFiles: function (task) {
        moveTaskFilesToTrash(task, {
          pathErrorMsg: this.$t('task.file-path-error'),
          delFailMsg: this.$t('task.remove-task-file-fail'),
          delConfigFailMsg: this.$t('task.remove-task-config-file-fail')
        })
      },
      removeTaskItem: function (task, isRemoveWithFiles) {
        this.$store.dispatch('task/removeTask', this.task)
          .then(() => {
            if (isRemoveWithFiles) {
              this.deleteTaskFiles(task)
            }
            this.$message.success(this.$t('task.delete-task-success', {
              taskName: this.taskName
            }))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$message.error(this.$t('task.delete-task-fail', {
                taskName: this.taskName
              }))
            }
          })
      },
      removeTaskRecord: function (task, isRemoveWithFiles) {
        this.$store.dispatch('task/removeTaskRecord', this.task)
          .then(() => {
            if (isRemoveWithFiles) {
              this.deleteTaskFiles(task)
            }
            this.$message.success(this.$t('task.remove-record-success', {
              taskName: this.taskName
            }))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$message.error(this.$t('task.remove-record-fail', {
                taskName: this.taskName
              }))
            }
          })
      },
      onResumeClick: function () {
        this.$store.dispatch('task/resumeTask', this.task)
          .catch(({ code }) => {
            if (code === 1) {
              this.$message.error(this.$t('task.resume-task-fail', {
                taskName: this.taskName
              }))
            }
          })
      },
      onPauseClick: function () {
        this.$store.dispatch('task/pauseTask', this.task)
          .catch(({ code }) => {
            if (code === 1) {
              this.$message.error(this.$t('task.pause-task-fail', {
                taskName: this.taskName
              }))
            }
          })
      },
      onDeleteClick: function () {
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
      onTrashClick: function () {
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
      onFolderClick: function () {
        showItemInFolder(this.path, {
          errorMsg: this.$t('task.file-not-exist')
        })
      },
      onLinkClick: function () {
        const uri = getTaskUri(this.task)
        clipboard.writeText(uri)
          .then(() => {
            this.$message.success(this.$t('task.copy-link-success'))
          })
      },
      onInfoClick: function () {
        this.$store.dispatch('task/showTaskItemInfoDialog', this.task)
      },
      onMoreClick: function () {
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
    border: 1px solid #F5F5F5;
    color: #9B9B9B;
    background-color: #fff;
    border-radius: 14px;
    transition: $--all-transition;
    &:hover {
      border-color: $--task-item-hover-border-color;
      color: #fff;
      background-color: $--task-item-hover-background;
      width: auto;
    }
    &> i {
      display: inline-block;
      padding: 5px;
      margin: 0 4px;
      font-size: 0;
      cursor: pointer;
    }
  }
</style>
