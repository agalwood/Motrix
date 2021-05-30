<template>
  <el-row class="task-progress-info">
    <el-col :span="6" class="task-progress-info-left">
      <div v-if="task.completedLength > 0 || task.totalLength > 0">
        <span>{{ task.completedLength | bytesToSize(2) }}</span>
        <span v-if="task.totalLength > 0"> / {{ task.totalLength | bytesToSize(2) }}</span>
      </div>
    </el-col>
    <el-col :span="18" class="task-progress-info-right">
      <div class="task-speed-info" v-if="isActive">
        <div class="task-speed-text" v-if="isBT">
          <i><mo-icon name="arrow-up" width="10" height="14" /></i>
          <span>{{ task.uploadSpeed | bytesToSize }}/s</span>
        </div>
        <div class="task-speed-text">
          <i><mo-icon name="arrow-down" width="10" height="14" /></i>
          <span>{{ task.downloadSpeed | bytesToSize }}/s</span>
        </div>
        <div class="task-speed-text" v-if="remaining > 0">
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
        <div class="task-speed-text" v-if="isBT">
          <i><mo-icon name="magnet" width="10" height="14" /></i>
          <span>{{ task.numSeeders }}</span>
        </div>
        <div class="task-speed-text">
          <i><mo-icon name="node" width="10" height="14" /></i>
          <span>{{ task.connections }}</span>
        </div>
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
  import '@/components/Icons/magnet'

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
  font-size: 0.75rem;
  line-height: 0.875rem;
  min-height: 0.875rem;
  color: #9B9B9B;
  margin-top: 0.5rem;
  i {
    font-style: normal;
  }
}
.task-progress-info-left {
  min-height: 0.875rem;
  text-align: left;
}
.task-progress-info-right {
  min-height: 0.875rem;
  text-align: right;
}
.task-speed-info {
  font-size: 0;
  & > .task-speed-text {
    margin-left: 0.375rem;
    font-size: 0;
    line-height: 0.875rem;
    vertical-align: middle;
    display: inline-block;
    &:first-of-type {
      margin-left: 0;
    }
    & > i, & > span {
      height: 0.875rem;
      line-height: 0.875rem;
      display: inline-block;
      vertical-align: middle;
    }
    & > i {
      margin-right: 0.125rem;
    }
    & > span {
      font-size: 0.75rem;
    }
  }
}
</style>
