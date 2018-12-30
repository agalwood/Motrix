<template>
  <li :key="task.gid" class="task-item" v-on:dblclick="toggleTask">
    <div class="task-name" :title="taskName">
      <span>{{ taskName }}</span>
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
              {{ remaining | timeFormat('剩余') }}
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
      taskName: function () {
        return getTaskName(this.task, '获取任务名中...')
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
      getTaskName,
      toggleTask () {
        const { status } = this.task
        if (['waiting', 'paused'].indexOf(status) === -1) {
          return
        }
        this.$store.dispatch('task/toggleTask', this.task)
      }
    }
  }
</script>

<style lang="scss">
  .task-item {
    position: relative;
    padding: 16px 12px;
    border: 1px solid #ccc;
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
</style>
