<template>
  <el-dialog
    custom-class="task-info-dialog"
    width="61.8vw"
    v-if="task"
    :title="dialogTitle"
    :show-close="true"
    :visible.sync="visible"
    :before-close="handleClose"
    @closed="handleClosed"
  >
    <div class="task-name" :title="taskFullName">
      <span>{{ taskFullName }}</span>
    </div>
    <mo-task-item-actions mode="ITEM" :task="task" />
    <div class="task-progress">
      <mo-task-progress
        :completed="Number(task.completedLength)"
        :total="Number(task.totalLength)"
        :status="task.status"
      />
      <mo-task-progress-info :task="task" />
    </div>
  </el-dialog>
</template>

<script>
  import { mapActions } from 'vuex'
  import { getTaskName } from '@shared/utils'
  import TaskItemActions from './TaskItemActions'
  import TaskProgress from './TaskProgress'
  import TaskProgressInfo from './TaskProgressInfo'
  import '@/components/Icons/task-start-line'
  import '@/components/Icons/task-pause-line'
  import '@/components/Icons/delete'
  import '@/components/Icons/folder'
  import '@/components/Icons/link'
  import '@/components/Icons/more'

  export default {
    name: 'mo-task-item-info',
    components: {
      [TaskItemActions.name]: TaskItemActions,
      [TaskProgress.name]: TaskProgress,
      [TaskProgressInfo.name]: TaskProgressInfo
    },
    props: {
      task: {
        type: Object
      },
      visible: {
        type: Boolean,
        default: false
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
          defaultName: this.$t('task.get-task-name'),
          maxLen: 32
        })
      },
      dialogTitle () {
        return this.$t('task.task-info-dialog-title', { title: this.taskName })
      }
    },
    methods: {
      handleClose (done) {
        this.$store.dispatch('task/hideTaskItemInfoDialog')
      },
      handleClosed (done) {
        this.$store.dispatch('task/updateCurrentTaskItem', null)
      },
      ...mapActions('task', [
        'toggleTask'
      ])
    }
  }
</script>

<style lang="scss">
  .task-info-dialog {
    min-width: 380px;
    .el-dialog__header {
      padding-right: 60px;
    }
    .el-dialog__body {
      position: relative;
    }
    .task-name {
      font-size: 14px;
      color: #505753;
      line-height: 26px;
      margin-bottom: 32px;
      margin-right: 200px;
    }
  }
  .task-item-info {
    padding: 16px 12px;
  }

  .task-item-actions {
    display: inline-block;
    position: absolute;
    top: 30px;
    right: 20px;
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
  .task-progress-info {
    font-size: 12px;
    line-height: 14px;
    min-height: 14px;
    color: #9B9B9B;
    margin-top: 8px;
  }
  .task-progress-info-left {
    min-height: 14px;
    text-align: left;
  }
  .task-progress-info-right {
    min-height: 14px;
    text-align: right;
  }
  .task-speed-info {
    & > .task-speed-text {
      margin-left: 8px;
      & > i {
        vertical-align: middle;
      }
    }
  }
</style>
