<template>
  <el-form
    class="mo-task-activity"
    ref="form"
    :model="form"
    :label-width="formLabelWidth"
    v-if="task"
  >
    <div class="graphic-box" ref="graphicBox">
      <mo-task-graphic
        :outerWidth="graphicWidth"
        :bitfield="task.bitfield"
        v-if="graphicWidth > 0"
      />
    </div>
    <el-form-item :label="`${$t('task.task-progress-info')}: `">
      <div class="form-static-value" style="overflow: hidden">
        <el-row :gutter="12">
          <el-col :span="18">
            <div class="progress-wrapper">
              <mo-task-progress
                :completed="Number(task.completedLength)"
                :total="Number(task.totalLength)"
                :status="task.status"
              />
            </div>
          </el-col>
          <el-col :span="5">
            {{ percent }}
          </el-col>
        </el-row>
      </div>
    </el-form-item>
    <el-form-item>
      <div class="form-static-value">
        <span>{{ task.completedLength | bytesToSize }}</span>
        <span v-if="task.totalLength > 0"> / {{ task.totalLength | bytesToSize }}</span>
        <span class="task-time-remaining" v-if="isActive && remaining > 0">
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
    </el-form-item>
    <el-form-item :label="`${$t('task.task-num-seeders')}: `" v-if="isBT">
      <div class="form-static-value">
        {{ task.numSeeders }}
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-connections')}: `">
      <div class="form-static-value">
        {{ task.connections }}
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-download-speed')}: `">
      <div class="form-static-value">
        <span>{{ task.downloadSpeed | bytesToSize }}/s</span>
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-upload-speed')}: `" v-if="isBT">
      <div class="form-static-value">
        <span>{{ task.uploadSpeed | bytesToSize }}/s</span>
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-upload-length')}: `" v-if="isBT">
      <div class="form-static-value">
        <span>{{ task.uploadLength | bytesToSize }}</span>
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-ratio')}: `" v-if="isBT">
      <div class="form-static-value">
        {{ ratio }}
      </div>
    </el-form-item>
  </el-form>
</template>

<script>
  import is from 'electron-is'
  import {
    bytesToSize,
    calcFormLabelWidth,
    calcProgress,
    calcRatio,
    checkTaskIsBT,
    checkTaskIsSeeder,
    timeFormat,
    timeRemaining
  } from '@shared/utils'
  import { TASK_STATUS } from '@shared/constants'
  import TaskGraphic from '@/components/TaskGraphic/Index'
  import TaskProgress from '@/components/Task/TaskProgress'

  export default {
    name: 'mo-task-activity',
    components: {
      [TaskGraphic.name]: TaskGraphic,
      [TaskProgress.name]: TaskProgress
    },
    props: {
      gid: {
        type: String
      },
      task: {
        type: Object
      },
      files: {
        type: Array,
        default: function () {
          return []
        }
      },
      peers: {
        type: Array,
        default: function () {
          return []
        }
      },
      visible: {
        type: Boolean,
        default: false
      }
    },
    data () {
      const { locale } = this.$store.state.preference.config
      return {
        form: {},
        formLabelWidth: calcFormLabelWidth(locale),
        locale,
        graphicWidth: 0
      }
    },
    computed: {
      isRenderer: () => is.renderer(),
      isBT () {
        return checkTaskIsBT(this.task)
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
      isActive () {
        return this.taskStatus === TASK_STATUS.ACTIVE
      },
      percent () {
        const { totalLength, completedLength } = this.task
        const percent = calcProgress(totalLength, completedLength)
        return `${percent}%`
      },
      remaining () {
        const { totalLength, completedLength, downloadSpeed } = this.task
        return timeRemaining(totalLength, completedLength, downloadSpeed)
      },
      ratio () {
        if (!this.isBT) {
          return 0
        }

        const { totalLength, uploadLength } = this.task
        const ratio = calcRatio(totalLength, uploadLength)
        return ratio
      }
    },
    filters: {
      bytesToSize,
      timeFormat
    },
    mounted () {
      setImmediate(() => {
        this.updateGraphicWidth()
      })
    },
    methods: {
      updateGraphicWidth () {
        if (!this.$refs.graphicBox) {
          return
        }
        this.graphicWidth = this.calcInnerWidth(this.$refs.graphicBox)
      },
      calcInnerWidth (ele) {
        if (!ele) {
          return 0
        }

        const style = getComputedStyle(ele, null)
        const width = parseInt(style.width, 10)
        const paddingLeft = parseInt(style.paddingLeft, 10)
        const paddingRight = parseInt(style.paddingRight, 10)
        return width - paddingLeft - paddingRight
      }
    }
  }
</script>

<style lang="scss">
.progress-wrapper {
  padding: 0.6875rem 0 0 0;
}

.task-time-remaining {
  margin-left: 1rem;
}
</style>
