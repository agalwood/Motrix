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
      <mo-task-progress :completed="Number(task.completedLength)" :total="Number(task.totalLength)" :status="task.status" />
      <el-row class="task-speed">
        <el-col :span="12" class="task-speed-left">
          <div v-if="task.totalLength > 0">
          {{ task.completedLength | bytesToSize }} / {{ task.totalLength | bytesToSize }}
          </div>
          <div v-else><!-- 等待中... --></div>
        </el-col>
        <el-col :span="12" class="task-speed-right">
          <div v-if="task.status ==='active'">
            <span>{{ task.downloadSpeed | bytesToSize }}/s</span>
            <span>
              {{
                remaining | timeFormat({
                  prefix: $t('task.remaining-prefix'),
                  i18n: {
                    'gt1d': $t('app.gt1d'),
                    'hour': $t('app.hour'),
                    'minute': $t('app.minute'),
                    'second': $t('app.second')
                  }
                })
              }}
            </span>
          </div>
        </el-col>
      </el-row>
    </div>
  </el-dialog>
</template>

<script>
  import { mapActions } from 'vuex'
  import TaskItemActions from './TaskItemActions'
  import TaskProgress from './TaskProgress'
  import '@/components/Icons/task-start-line'
  import '@/components/Icons/task-pause-line'
  import '@/components/Icons/delete'
  import '@/components/Icons/folder'
  import '@/components/Icons/link'
  import '@/components/Icons/more'
  import {
    getTaskName,
    timeRemaining,
    bytesToSize,
    timeFormat
  } from '@shared/utils'

  export default {
    name: 'mo-task-item-info',
    components: {
      [TaskItemActions.name]: TaskItemActions,
      [TaskProgress.name]: TaskProgress
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
      taskFullName: function () {
        return getTaskName(this.task, {
          defaultName: this.$t('task.get-task-name'),
          maxLen: -1
        })
      },
      taskName: function () {
        return getTaskName(this.task, {
          defaultName: this.$t('task.get-task-name'),
          maxLen: 32
        })
      },
      dialogTitle: function () {
        return this.$t('task.task-info-dialog-title', { title: this.taskName })
      },
      remaining: function () {
        const { totalLength, completedLength, downloadSpeed } = this.task
        return timeRemaining(totalLength, completedLength, downloadSpeed)
      }
    },
    filters: {
      bytesToSize,
      timeFormat
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
  .task-speed {
    font-size: 12px;
    line-height: 14px;
    min-height: 14px;
    color: #9B9B9B;
    margin-top: 8px;
  }
  .task-speed-left {
    min-height: 14px;
    text-align: left;
  }
  .task-speed-right {
    min-height: 14px;
    text-align: right;
  }
</style>
