<template>
  <el-row class="task-progress-info">
    <el-col :span="10" class="task-progress-info-left">
      <div v-if="task.totalLength > 0">
      {{ task.completedLength | bytesToSize }} / {{ task.totalLength | bytesToSize }}
      </div>
    </el-col>
    <el-col :span="14" class="task-progress-info-right">
      <div class="task-speed-info" v-if="isActive">
        <span class="task-speed-text" v-if="isBT">
          <i><mo-icon name="arrow-up" width="10" height="10" /></i>
          <i>{{ task.uploadSpeed | bytesToSize }}/s</i>
        </span>
        <span class="task-speed-text">
          <i><mo-icon name="arrow-down" width="10" height="10" /></i>
          <i>{{ task.downloadSpeed | bytesToSize }}/s</i>
        </span>
        <span class="task-speed-text" v-if="remaining > 0">
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
        <span class="task-speed-text">
          <i><mo-icon name="node" width="10" height="10" /></i>
          <i>{{ task.connections }}</i>
        </span>
      </div>
    </el-col>
  </el-row>
</template>

<script>
  import {
    bytesToSize,
    checkTaskIsBT,
    checkTaskIsSeeder,
    timeFormat,
    timeRemaining
  } from '@shared/utils'
  import { TASK_STATUS } from '@shared/constants'
  import '@/components/Icons/arrow-up'
  import '@/components/Icons/arrow-down'
  import '@/components/Icons/node'

  export default {
    name: 'mo-task-progress-info',
    props: {
      task: {
        type: Object
      }
    },
    computed: {
      isActive () {
        return this.task.status === TASK_STATUS.ACTIVE
      },
      isBT () {
        return checkTaskIsBT(this.task)
      },
      isSeeder () {
        return checkTaskIsSeeder(this.task)
      },
      remaining () {
        const { totalLength, completedLength, downloadSpeed } = this.task
        return timeRemaining(totalLength, completedLength, downloadSpeed)
      }
    },
    filters: {
      bytesToSize,
      timeFormat
    }
  }
</script>

<style lang="scss">
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
