<template>
  <el-container class="content panel" direction="vertical">
    <el-header class="panel-header" height="84">
      <h4>{{ title }}</h4>
    </el-header>
    <el-main class="panel-content">
      <el-form
        class="form-preference"
        ref="basicForm"
        label-position="right"
        size="mini"
        :model="form"
        :rules="rules">
        <el-form-item :label="`${$t('preferences.startup')}: `" :label-width="formLabelWidth">
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.resumeAllWhenAppLaunched">
              {{ $t('preferences.auto-resume-all') }}
            </el-checkbox>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.autoCheckUpdate">
              {{ $t('preferences.auto-check-update') }}
            </el-checkbox>
            <div class="el-form-item__info" style="margin-top: 8px;" v-if="form.lastCheckUpdateTime !== 0">
              {{ $t('preferences.last-check-update-time') + ': ' + (form.lastCheckUpdateTime !== 0 ?  new
              Date(form.lastCheckUpdateTime).toLocaleString() : new Date().toLocaleString()) }}
            </div>
          </el-col>
        </el-form-item>
        <el-form-item :label="`${$t('preferences.default-dir')}: `" :label-width="formLabelWidth">
          <el-input placeholder="" v-model="downloadDir" :readonly="isMas()">
            <mo-select-directory
              v-if="isRenderer()"
              slot="append"
              @selected="onDirectorySelected"
            />
          </el-input>
          <div class="el-form-item__info" v-if="isMas()" style="margin-top: 8px;">
            {{ $t('preferences.mas-default-dir-tip') }}
          </div>
        </el-form-item>
        <el-form-item :label="`${$t('preferences.task-manage')}: `" :label-width="formLabelWidth">
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.max-concurrent-downloads') }}
            <el-input-number
              v-model="form.maxConcurrentDownloads"
              controls-position="right"
              :min="1"
              :max="10"
              :label="$t('preferences.max-concurrent-downloads')">
            </el-input-number>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.max-connection-per-server') }}
            <el-input-number
              v-model="form.split"
              controls-position="right"
              :min="1"
              :max="form.maxConnectionPerServer"
              :label="$t('preferences.max-connection-per-server')">
            </el-input-number>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.continue">
              {{ $t('preferences.continue') }}
            </el-checkbox>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.newTaskShowDownloading">
              {{ $t('preferences.new-task-show-downloading') }}
            </el-checkbox>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.taskNotification">
              {{ $t('preferences.task-completed-notify') }}
            </el-checkbox>
          </el-col>
        </el-form-item>
      </el-form>
      <div class="form-actions">
        <el-button type="primary" @click="submitForm('basicForm')">{{ $t('preferences.save') }}</el-button>
        <el-button @click="resetForm('basicForm')">{{ $t('preferences.discard') }}</el-button>
      </div>
    </el-main>
  </el-container>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'
  import SelectDirectory from '@/components/Native/SelectDirectory'
  import { prettifyDir } from '@/components/Native/utils'

  const initialForm = (config) => {
    const {
      dir,
      split,
      resumeAllWhenAppLaunched,
      maxConcurrentDownloads,
      maxConnectionPerServer,
      taskNotification,
      autoCheckUpdate,
      newTaskShowDownloading,
      lastCheckUpdateTime
    } = config
    const result = {
      dir,
      split,
      continue: config.continue,
      resumeAllWhenAppLaunched,
      maxConcurrentDownloads,
      maxConnectionPerServer,
      taskNotification,
      autoCheckUpdate,
      newTaskShowDownloading,
      lastCheckUpdateTime
    }
    return result
  }

  export default {
    name: 'mo-preference-basic',
    components: {
      [SelectDirectory.name]: SelectDirectory
    },
    data: function () {
      return {
        formLabelWidth: '23%',
        form: initialForm(this.$store.state.preference.config),
        rules: {}
      }
    },
    computed: {
      title: function () {
        return this.$t('preferences.basic')
      },
      downloadDir: function () {
        return prettifyDir(this.form.dir)
      },
      ...mapState('preference', {
        config: state => state.config
      })
    },
    methods: {
      isRenderer: is.renderer,
      isMas: is.mas,
      onDirectorySelected (dir) {
        this.form.dir = dir
      },
      submitForm (formName) {
        this.$refs[formName].validate((valid) => {
          if (!valid) {
            console.log('error submit!!')
            return false
          }

          this.$store.dispatch('preference/save', this.form)
          if (this.isRenderer()) {
            this.$electron.ipcRenderer.send('command', 'application:relaunch')
          }
        })
      },
      resetForm (formName) {
        this.form = initialForm(this.$store.state.preference.config)
      }
    }
  }
</script>

<style lang="scss">
</style>
