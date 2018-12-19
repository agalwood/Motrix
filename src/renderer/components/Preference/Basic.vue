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
        <el-form-item label="启动: " :label-width="formLabelWidth">
          <el-checkbox v-model="form.resumeAllWhenAppLaunched">
            启动后自动开始未完成任务
          </el-checkbox>
        </el-form-item>
        <el-form-item label="默认下载路径: " :label-width="formLabelWidth">
          <el-input placeholder="" v-model="downloadDir" :readonly="isMas()">
            <mo-select-directory
              v-if="isRenderer()"
              slot="append"
              @selected="onDirectorySelected"
            />
          </el-input>
          <div class="el-form-item__info" v-if="isMas()" style="margin-top: 8px;">
            因 App Store 的沙箱权限限制，默认下载路径建议设置为您的「下载」目录
          </div>
        </el-form-item>
        <el-form-item label="任务管理: " :label-width="formLabelWidth">
          <el-col class="form-item-sub" :span="24">
            同时下载的最大任务数
            <el-input-number
              v-model="form.maxConcurrentDownloads"
              controls-position="right"
              :min="1"
              :max="10"
              label="同时下载最大任务数">
            </el-input-number>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            单任务下载的线程数
            <el-input-number
              v-model="form.split"
              controls-position="right"
              :min="1"
              :max="64"
              label="单任务下载线程数">
            </el-input-number>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.continue">
              断点续传
            </el-checkbox>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.newTaskShowDownloading">
              新建任务后自动跳转到下载页面
            </el-checkbox>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.taskNotification">
              下载完成后通知
            </el-checkbox>
          </el-col>
        </el-form-item>
      </el-form>
      <div class="form-actions">
        <el-button type="primary" @click="submitForm('basicForm')">保存并应用</el-button>
        <el-button @click="resetForm('basicForm')">放弃</el-button>
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
      taskNotification,
      newTaskShowDownloading
    } = config
    console.log('initialForm===>', dir, split)
    const result = {
      dir,
      split,
      userAgent: '',
      referer: '',
      cookie: '',
      continue: config.continue,
      resumeAllWhenAppLaunched,
      maxConcurrentDownloads,
      taskNotification,
      newTaskShowDownloading
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
        return '基础设置'
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
