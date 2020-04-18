<template>
  <li :key="task.gid" class="task-item" v-on:dblclick="onDbClick">
    <div class="task-name" :title="taskFullName">
      <span>{{ taskFullName }}</span>
    </div>
    <mo-task-item-actions mode="LIST" :task="task" />
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
            <span class="task-connections">
              <i><mo-icon name="node" width="10" height="10" /></i>
              <i>{{ task.connections }}</i>
            </span>
          </div>
        </el-col>
      </el-row>
    </div>
  </li>
</template>

<script>
  import TaskItemActions from './TaskItemActions'
  import TaskProgress from './TaskProgress'
  import '@/components/Icons/node'
  import {
    getTaskName,
    getTaskFullPath,
    timeRemaining,
    bytesToSize,
    timeFormat
  } from '@shared/utils'
  import {
    openItem
  } from '@/components/Native/utils'
  import { TASK_STATUS } from '@shared/constants'

  export default {
    name: 'mo-task-item',
    components: {
      [TaskItemActions.name]: TaskItemActions,
      [TaskProgress.name]: TaskProgress
    },
    props: {
      task: {
        type: Object
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
          defaultName: this.$t('task.get-task-name')
        })
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
  .task-name {
    color: #505753;
    margin-bottom: 32px;
    margin-right: 240px;
    word-break: break-all;
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
  .task-connections {
    margin-left: 8px;
    & > i {
      vertical-align: middle;
    }
  }
</style>
