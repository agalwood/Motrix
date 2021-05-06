<template>
  <el-form
    class="mo-task-general"
    ref="form"
    :model="form"
    :label-width="formLabelWidth"
    v-if="task"
  >
    <el-form-item :label="`${$t('task.task-name')}: `">
      <div class="form-static-value">
        {{ taskFullName }}
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-dir')}: `">
      <el-input placeholder="" readonly v-model="path">
        <mo-show-in-folder
          slot="append"
          v-if="isRenderer"
          :path="path"
        />
      </el-input>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-status')}: `">
      <div class="form-static-value">
        <mo-task-status :theme="currentTheme" :status="taskStatus" />
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-error-info')}: `" v-if="task.errorCode && task.errorCode !== '0'">
      <div class="form-static-value">
        {{ task.errorCode }} {{ task.errorMessage }}
      </div>
    </el-form-item>

    <el-divider v-if="isBT">
      <i class="el-icon-attract"></i>
      {{ $t('task.task-bittorrent-info') }}
    </el-divider>

    <el-form-item :label="`${$t('task.task-info-hash')}: `" v-if="isBT">
      <div class="form-static-value">
        {{ task.infoHash }}
        <i class="copy-link" @click="handleCopyClick">
          <mo-icon
            name="link"
            width="12"
            height="12"
          />
        </i>
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-piece-length')}: `" v-if="isBT">
      <div class="form-static-value">
        {{ task.pieceLength | bytesToSize }}
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-num-pieces')}: `" v-if="isBT">
      <div class="form-static-value">
        {{ task.numPieces }}
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-bittorrent-creation-date')}: `" v-if="isBT">
      <div class="form-static-value">
        {{ task.bittorrent.creationDate | localeDateTimeFormat(locale) }}
      </div>
    </el-form-item>
    <el-form-item :label="`${$t('task.task-bittorrent-comment')}: `" v-if="isBT">
      <div class="form-static-value">
        {{ task.bittorrent.comment }}
      </div>
    </el-form-item>
  </el-form>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'
  import * as clipboard from 'clipboard-polyfill'
  import {
    bytesToSize,
    calcFormLabelWidth,
    checkTaskIsBT,
    checkTaskIsSeeder,
    getTaskName,
    getTaskUri,
    localeDateTimeFormat
  } from '@shared/utils'
  import { APP_THEME, TASK_STATUS } from '@shared/constants'
  import { getTaskFullPath } from '@/utils/native'
  import ShowInFolder from '@/components/Native/ShowInFolder'
  import TaskStatus from '@/components/Task/TaskStatus'
  import '@/components/Icons/folder'
  import '@/components/Icons/link'

  export default {
    name: 'mo-task-general',
    components: {
      [ShowInFolder.name]: ShowInFolder,
      [TaskStatus.name]: TaskStatus
    },
    props: {
      task: {
        type: Object
      }
    },
    data () {
      const { locale } = this.$store.state.preference.config
      return {
        form: {},
        formLabelWidth: calcFormLabelWidth(locale),
        locale
      }
    },
    computed: {
      ...mapState('app', {
        systemTheme: state => state.systemTheme
      }),
      ...mapState('preference', {
        theme: state => state.config.theme
      }),
      currentTheme () {
        if (this.theme === APP_THEME.AUTO) {
          return this.systemTheme
        } else {
          return this.theme
        }
      },
      isRenderer: () => is.renderer(),
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
      path () {
        return getTaskFullPath(this.task)
      },
      isBT () {
        return checkTaskIsBT(this.task)
      }
    },
    filters: {
      bytesToSize,
      localeDateTimeFormat
    },
    methods: {
      handleCopyClick () {
        const { task } = this
        const uri = getTaskUri(task)
        clipboard.writeText(uri)
          .then(() => {
            this.$msg.success(this.$t('task.copy-link-success'))
          })
      }
    }
  }
</script>

<style lang="scss">
.copy-link {
  cursor: pointer;
}
</style>
