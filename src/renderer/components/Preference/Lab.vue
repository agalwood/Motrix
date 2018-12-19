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
        <el-form-item :label-width="formLabelWidth">
          <div class="el-form-item__error">⚠️启用实验特性可能造成应用崩溃或数据丢失，请自行决定！</div>
        </el-form-item>
        <el-form-item label="下载协议: " :label-width="formLabelWidth">
          <el-col class="form-item-sub" :span="24">
            <el-switch
              v-model="form.enableEggFeatures"
              active-text="支持更多下载协议"
              >
            </el-switch>
          </el-col>
        </el-form-item>
        <el-form-item label="浏览器扩展: " :label-width="formLabelWidth">
          <el-col class="form-item-sub" :span="24">
            <a target="_blank" href="https://motrix.app/release/BaiduExporter.zip" rel="noopener noreferrer">
              百度网盘助手
              <mo-icon name="link" width="14" height="14" />
            </a>
            <div class="el-form-item__info" style="margin-top: 8px;">
              社区提供的浏览器扩展「不保证可用性」，
              <a target="_blank" href="https://motrix.app/extensions/baidu" rel="noopener noreferrer">
                点此查看使用说明
              </a>
            </div>
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
  import '@/components/Icons/info-square'

  const initialForm = (config) => {
    const {
      enableEggFeatures
    } = config
    const result = {
      enableEggFeatures
    }
    return result
  }

  export default {
    name: 'mo-preference-lab',
    components: {
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
        return '实验室'
      },
      ...mapState('preference', {
        config: state => state.config
      })
    },
    watch: {

    },
    methods: {
      isRenderer: is.renderer,
      submitForm (formName) {
        this.$refs[formName].validate((valid) => {
          if (!valid) {
            console.log('error submit!!')
            return false
          }

          console.log('this.form===>', this.form)
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
