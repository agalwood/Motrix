<template>
  <el-container class="content panel" direction="vertical">
    <el-header class="panel-header" height="84">
      <h4>{{ title }}</h4>
    </el-header>
    <el-main class="panel-content">
      <el-form
        class="form-preference"
        ref="advancedForm"
        label-position="right"
        size="mini"
        :model="form"
        :rules="rules">
        <el-form-item :label="`${$t('preferences.language')}: `" :label-width="formLabelWidth">
          <el-select
            v-model="locale"
            @change="handleLocaleChange"
            :placeholder="$t('preferences.change-language')">
            <el-option
              v-for="item in locales"
              :key="item.value"
              :label="item.label"
              :value="item.value">
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item :label="`${$t('preferences.proxy')}: `" :label-width="formLabelWidth">
          <el-switch
            v-model="form.useProxy"
            :active-text="$t('preferences.use-proxy')"
            @change="onUseProxyChange"
            >
          </el-switch>
        </el-form-item>
        <el-form-item label="" :label-width="formLabelWidth" v-if="form.useProxy">
          <el-col class="form-item-sub" :span="16">
            <el-input
              placeholder="[http://][USER:PASSWORD@]HOST[:PORT]"
              @change="onAllProxyBackupChange"
              v-model="form.allProxyBackup">
            </el-input>
          </el-col>
        </el-form-item>
        <el-form-item :label="`${$t('preferences.developer')}: `" :label-width="formLabelWidth">
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.mock-user-agent') }}
            <el-input
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 3 }"
              auto-complete="off"
              placeholder="User-Agent"
              v-model="form.userAgent">
            </el-input>
            <el-button-group class="ua-group">
              <el-button @click="() => changeUA('transmission')">Transmission</el-button>
              <el-button @click="() => changeUA('chrome')">Chrome</el-button>
              <el-button @click="() => changeUA('du')">du</el-button>
            </el-button-group>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.app-log-path') }}
            <el-input placeholder="" disabled v-model="logPath">
              <mo-show-in-folder
                slot="append"
                v-if="isRenderer()"
                :path="logPath"
              />
            </el-input>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.download-session-path') }}
            <el-input placeholder="" disabled v-model="sessionPath">
              <mo-show-in-folder
                slot="append"
                v-if="isRenderer()"
                :path="sessionPath"
              />
            </el-input>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-button plain type="danger" @click="() => onFactoryResetClick()">{{ $t('preferences.factory-reset') }}</el-button>
          </el-col>
        </el-form-item>
      </el-form>
      <div class="form-actions">
        <el-button type="primary" @click="submitForm('advancedForm')">{{ $t('preferences.save') }}</el-button>
        <el-button @click="resetForm('advancedForm')">{{ $t('preferences.discard') }}</el-button>
      </div>
    </el-main>
  </el-container>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'
  import ShowInFolder from '@/components/Native/ShowInFolder'
  import userAgentMap from '@shared/ua'
  import { determineLocale } from '@shared/utils'

  const initialForm = (config) => {
    const {
      useProxy,
      allProxy,
      allProxyBackup,
      userAgent
    } = config
    const result = {
      useProxy,
      allProxy,
      allProxyBackup,
      userAgent
    }
    return result
  }

  export default {
    name: 'mo-preference-advanced',
    components: {
      [ShowInFolder.name]: ShowInFolder
    },
    data: function () {
      return {
        formLabelWidth: '23%',
        form: initialForm(this.$store.state.preference.config),
        rules: {},
        color: '#c00',
        locale: 'zh-CN',
        locales: [
          {
            value: 'zh-CN',
            label: '🇨🇳 简体中文'
          },
          {
            value: 'en-US',
            label: '🇺🇸 English (US)'
          }
        ]
      }
    },
    computed: {
      title: function () {
        return this.$t('preferences.advanced')
      },
      ...mapState('preference', {
        config: state => state.config,
        logPath: state => state.config.logPath,
        sessionPath: state => state.config.sessionPath
      })
    },
    watch: {

    },
    methods: {
      isRenderer: is.renderer,
      handleLocaleChange (value) {
        console.log('handleLocaleChange=>', value)
        const lng = determineLocale(value)
        // this.$i18n.locale = locale
        this.$i18n.i18next.changeLanguage(lng)
      },
      onUseProxyChange (flag) {
        this.form.allProxy = flag ? this.form.allProxyBackup : ''
        console.log('this.form.allProxy===>', flag, this.form.allProxy)
      },
      onAllProxyBackupChange (value) {
        this.form.allProxy = value
      },
      changeUA (type) {
        const ua = userAgentMap[type]
        console.log('changeUA===>', ua)
        if (!ua) {
          return
        }
        this.form.userAgent = ua
      },
      onFactoryResetClick () {
        this.$electron.remote.dialog.showMessageBox({
          type: 'warning',
          title: '恢复初始设置',
          message: '你确定要恢复为初始设置吗?',
          buttons: [this.$t('app.yes'), this.$t('app.no')],
          cancelId: 1
        }, (buttonIndex) => {
          if (buttonIndex === 0) {
            this.$electron.ipcRenderer.send('command', 'application:reset')
          }
        })
      },
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
  .ua-group {
    margin-top: 8px;
  }
</style>
