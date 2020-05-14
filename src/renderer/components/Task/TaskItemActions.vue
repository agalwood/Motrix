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
      <i v-if="action === 'RESTART'" @click.stop="onRestartClick">
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
  import { mapState } from 'vuex'
  import is from 'electron-is'

  import { commands } from '@/components/CommandManager/instance'
  import { TASK_STATUS } from '@shared/constants'
  import {
    checkTaskIsSeeder,
    getTaskFullPath,
    getTaskName
  } from '@shared/utils'
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

  const taskActionsMap = {
    [TASK_STATUS.ACTIVE]: ['PAUSE', 'DELETE'],
    [TASK_STATUS.PAUSED]: ['RESUME', 'DELETE'],
    [TASK_STATUS.WAITING]: ['RESUME', 'DELETE'],
    [TASK_STATUS.ERROR]: ['RESTART', 'TRASH'],
    [TASK_STATUS.COMPLETE]: ['RESTART', 'TRASH'],
    [TASK_STATUS.REMOVED]: ['RESTART', 'TRASH'],
    [TASK_STATUS.SEEDING]: ['STOP', 'DELETE']
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
      ...mapState('preference', {
        noConfirmBeforeDelete: state => state.config.noConfirmBeforeDeleteTask
      }),
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
          return TASK_STATUS.SEEDING
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
      onResumeClick () {
        const { task, taskName } = this
        commands.emit('resume-task', {
          task,
          taskName
        })
      },
      onRestartClick (event) {
        const { task, taskName } = this
        const { status } = task
        const showDialog = status === TASK_STATUS.COMPLETE || !!event.altKey
        commands.emit('restart-task', {
          task,
          taskName,
          showDialog
        })
      },
      onPauseClick () {
        const { task, taskName } = this
        commands.emit('pause-task', {
          task,
          taskName
        })
      },
      onStopClick () {
        if (!this.isSeeder) {
          return
        }

        const { task } = this
        commands.emit('stop-task-seeding', { task })
      },
      onDeleteClick (event) {
        const { task, taskName } = this
        const deleteWithFiles = !!event.shiftKey
        commands.emit('delete-task', {
          task,
          taskName,
          deleteWithFiles
        })
      },
      onTrashClick (event) {
        const { task, taskName } = this
        const deleteWithFiles = !!event.shiftKey
        commands.emit('delete-task-record', {
          task,
          taskName,
          deleteWithFiles
        })
      },
      onFolderClick () {
        const { path } = this
        commands.emit('reveal-in-folder', { path })
      },
      onLinkClick () {
        const { task } = this
        commands.emit('copy-task-link', { task })
      },
      onInfoClick () {
        const { task } = this
        commands.emit('show-task-info', { task })
      },
      onMoreClick () {
      }
    }
  }
</script>

<style lang="scss">
  .task-item-actions {
    // width: 28px;
    height: 24px;
    padding: 0 10px;
    margin: 0;
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
