<template>
  <div class="task-actions">
    <el-tooltip
      class="item hidden-md-and-up"
      effect="dark"
      :content="$t('task.new-task')"
      placement="bottom"
    >
      <i class="task-action" @click.stop="onAddClick">
        <mo-icon name="menu-add" width="14" height="14" />
      </i>
    </el-tooltip>
    <el-tooltip
      class="item"
      effect="dark"
      placement="bottom"
      :content="$t('task.delete-selected-tasks')"
    >
      <i
        class="task-action"
        :class="{ disabled: selectedGidListCount === 0 }"
        @click="onBatchDeleteClick">
        <mo-icon name="delete" width="14" height="14" />
      </i>
    </el-tooltip>
    <el-tooltip class="item" effect="dark" :content="$t('task.refresh-list')" placement="bottom">
      <i class="task-action" @click="onRefreshClick">
        <mo-icon name="refresh" width="14" height="14" :spin="refreshing" />
      </i>
    </el-tooltip>
    <el-tooltip class="item" effect="dark" :content="$t('task.resume-all-task')" placement="bottom">
      <i class="task-action" @click="onResumeAllClick">
        <mo-icon name="task-start-line" width="14" height="14" />
      </i>
    </el-tooltip>
    <el-tooltip class="item" effect="dark" :content="$t('task.pause-all-task')" placement="bottom">
      <i class="task-action" @click="onPauseAllClick">
        <mo-icon name="task-pause-line" width="14" height="14" />
      </i>
    </el-tooltip>
    <el-tooltip
      class="item"
      effect="dark"
      :content="$t('task.purge-record')"
      placement="bottom"
      v-if="currentList === 'stopped'"
    >
      <i class="task-action" @click="onPurgeRecordClick">
        <mo-icon name="purge" width="14" height="14" />
      </i>
    </el-tooltip>
  </div>
</template>

<script>
  import { mapState } from 'vuex'
  import { ADD_TASK_TYPE } from '@shared/constants'
  import { bytesToSize, timeFormat } from '@shared/utils'
  import {
    moveTaskFilesToTrash
  } from '@/components/Native/utils'
  import '@/components/Icons/menu-add'
  import '@/components/Icons/refresh'
  import '@/components/Icons/task-start-line'
  import '@/components/Icons/task-pause-line'
  import '@/components/Icons/delete'
  import '@/components/Icons/purge'
  import '@/components/Icons/more'

  export default {
    name: 'mo-task-actions',
    components: {
    },
    props: ['task'],
    data: function () {
      return {
        refreshing: false
      }
    },
    computed: {
      ...mapState('task', {
        currentList: state => state.currentList,
        taskList: state => state.taskList,
        selectedGidList: state => state.selectedGidList,
        selectedGidListCount: state => state.selectedGidList.length
      })
    },
    filters: {
      bytesToSize,
      timeFormat
    },
    methods: {
      refreshSpin: function () {
        this.t && clearTimeout(this.t)

        this.refreshing = true
        this.t = setTimeout(() => {
          this.refreshing = false
        }, 500)
      },
      delayDeleteTaskFiles (task, delay) {
        return new Promise((resolve) => {
          setTimeout(() => {
            try {
              const result = moveTaskFilesToTrash(task)
              resolve(result)
            } catch (err) {
              console.log('[Motrix] batch delay delete task files fail', err)
              resolve(false)
            }
          }, delay)
        })
      },
      batchDeleteTaskFiles (taskList) {
        const promises = taskList.map((task, index) => this.delayDeleteTaskFiles(task, index * 200))
        Promise.all(promises).then(values => {
          console.log(values)
        })
      },
      removeTasks (taskList, isRemoveWithFiles) {
        const gids = taskList.map((task) => task.gid)
        this.$store.dispatch('task/batchForcePauseTask', gids)
          .finally(() => {
            if (isRemoveWithFiles) {
              this.batchDeleteTaskFiles(taskList)
            }

            this.removeTaskItems(gids)
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
      onBatchDeleteClick: function (event) {
        const self = this
        const { taskList, selectedGidList, selectedGidListCount } = this
        if (selectedGidListCount === 0) {
          event.preventDefault()
          return
        }

        const selectedTaskList = taskList.filter((task) => {
          return selectedGidList.includes(task.gid)
        })
        const count = `${selectedGidListCount}`
        const isChecked = !!event.shiftKey
        this.$electron.remote.dialog.showMessageBox({
          type: 'warning',
          title: this.$t('task.delete-selected-task'),
          message: this.$t('task.batch-delete-task-confirm', { count }),
          buttons: [this.$t('app.yes'), this.$t('app.no')],
          cancelId: 1,
          checkboxLabel: this.$t('task.delete-task-label'),
          checkboxChecked: isChecked
        }).then(({ response, checkboxChecked }) => {
          if (response === 0) {
            self.removeTasks(selectedTaskList, checkboxChecked)
          }
        })
      },
      onRefreshClick: function () {
        this.refreshSpin()
        this.$store.dispatch('task/fetchList')
      },
      onResumeAllClick: function () {
        this.$store.dispatch('task/resumeAllTask')
          .then(() => {
            this.$msg.success(this.$t('task.resume-all-task-success'))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.resume-all-task-fail'))
            }
          })
      },
      onPauseAllClick: function () {
        this.$store.dispatch('task/pauseAllTask')
          .then(() => {
            this.$msg.success(this.$t('task.pause-all-task-success'))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.pause-all-task-fail'))
            }
          })
      },
      onPurgeRecordClick: function () {
        this.$store.dispatch('task/purgeTaskRecord')
          .then(() => {
            this.$msg.success(this.$t('task.purge-record-success'))
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$msg.error(this.$t('task.purge-record-fail'))
            }
          })
      },
      onAddClick: function () {
        this.$store.dispatch('app/showAddTaskDialog', ADD_TASK_TYPE.URI)
      }
    }
  }
</script>

<style lang="scss">
  .task-actions {
    position: absolute;
    top: 44px;
    right: 0;
    height: 24px;
    padding: 0;
    overflow: hidden;
    user-select: none;
    cursor: default;
    text-align: right;
    color: $--task-action-color;
    transition: all 0.25s;
    .task-action {
      display: inline-block;
      padding: 5px;
      margin: 0 4px;
      font-size: 0;
      cursor: pointer;
      outline: none;
      &:hover {
        color: $--task-action-hover-color;
      }
      &.disabled {
        color: $--task-action-disabled-color;
      }
    }
  }
</style>
