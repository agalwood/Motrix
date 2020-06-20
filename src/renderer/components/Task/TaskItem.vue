<template>
  <div :key="task.gid" class="task-item" v-on:dblclick="onDbClick">
    <div class="task-name" :title="taskFullName">
      <span>{{ taskFullName }}</span>
    </div>
    <mo-task-item-actions mode="LIST" :task="task" />
    <div class="task-progress">
      <mo-task-progress
        :completed="Number(task.completedLength)"
        :total="Number(task.totalLength)"
        :status="task.status"
      />
      <mo-task-progress-info :task="task" />
    </div>
  </div>
</template>

<script>
  import { getTaskName } from '@shared/utils'
  import { TASK_STATUS } from '@shared/constants'
  import { openItem, getTaskFullPath } from '@/utils/native'
  import TaskItemActions from './TaskItemActions'
  import TaskProgress from './TaskProgress'
  import TaskProgressInfo from './TaskProgressInfo'

  export default {
    name: 'mo-task-item',
    components: {
      [TaskItemActions.name]: TaskItemActions,
      [TaskProgress.name]: TaskProgress,
      [TaskProgressInfo.name]: TaskProgressInfo
    },
    props: {
      task: {
        type: Object
      }
    },
    computed: {
      taskFullName () {
        return getTaskName(this.task, {
          defaultName: this.$t('task.get-task-name'),
          maxLen: -1
        })
      },
      taskName () {
        return getTaskName(this.task, {
          defaultName: this.$t('task.get-task-name')
        })
      }
    },
    methods: {
      onDbClick () {
        const { status } = this.task
        const { COMPLETE, WAITING, PAUSED } = TASK_STATUS
        if (status === COMPLETE) {
          this.openTask()
        } else if ([WAITING, PAUSED].includes(status) !== -1) {
          this.toggleTask()
        }
      },
      openTask () {
        const { taskName } = this
        this.$msg.info(this.$t('task.opening-task-message', { taskName }))
        const fullPath = getTaskFullPath(this.task)
        openItem(fullPath, {
          errorMsg: this.$t('task.file-not-exist')
        })
      },
      toggleTask () {
        this.$store.dispatch('task/toggleTask', this.task)
      }
    }
  }
</script>

<style lang="scss">
  .task-item {
    position: relative;
    min-height: 88px;
    padding: 16px 12px;
    background-color: $--task-item-background;
    border: 1px solid $--task-item-border-color;
    border-radius: 6px;
    margin-bottom: 16px;
    transition: $--border-transition-base;
    &:hover {
      border-color: $--task-item-hover-border-color;
    }
    .task-item-actions {
      position: absolute;
      top: 16px;
      right: 12px;
    }
  }
  .selected .task-item {
    border-color: $--task-item-hover-border-color;
  }
  .task-name {
    color: #505753;
    margin-bottom: 32px;
    margin-right: 240px;
    word-break: break-all;
    min-height: 26px;
    &> span {
      font-size: 14px;
      line-height: 26px;
      overflow : hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
  }
</style>
