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
        <el-form-item :label="`${$t('preferences.auto-update')}: `" :label-width="formLabelWidth">
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
        <el-form-item :label="`${$t('preferences.bt-tracker')}: `" :label-width="formLabelWidth">
          <div class="bt-tracker">
            <el-input
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 5 }"
              auto-complete="off"
              :placeholder="`${$t('preferences.bt-tracker-input-tips')}`"
              v-model="form.btTracker">
            </el-input>
            <div class="sync-tracker">
              <el-tooltip
                class="item"
                effect="dark"
                :content="$t('preferences.sync-tracker-tips')"
                placement="bottom"
              >
                <el-button
                  @click="syncTrackerFromGitHub"
                >
                  <mo-icon
                    name="refresh"
                    width="12"
                    height="12"
                    :spin="true"
                    v-if="trackerSyncing"
                  />
                  <mo-icon name="sync" width="12" height="12" v-else />
                </el-button>
              </el-tooltip>
            </div>
          </div>
          <div class="el-form-item__info" style="margin-top: 8px;">
            {{ $t('preferences.bt-tracker-tips') }}
            <a target="_blank" href="https://github.com/ngosang/trackerslist" rel="noopener noreferrer">
              https://github.com/ngosang/trackerslist
              <mo-icon name="link" width="12" height="12" />
            </a>
          </div>
        </el-form-item>
        <el-form-item :label="`${$t('preferences.security')}: `" :label-width="formLabelWidth">
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
        </el-form-item>
        <el-form-item :label="`${$t('preferences.developer')}: `" :label-width="formLabelWidth">
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
            <el-button plain type="danger" @click="() => onFactoryResetClick()">
              {{ $t('preferences.factory-reset') }}
            </el-button>
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
  import { cloneDeep } from 'lodash'
  import ShowInFolder from '@/components/Native/ShowInFolder'
  import userAgentMap from '@shared/ua'
  import {
    convertCommaToLine,
    convertLineToComma,
    diffConfig
  } from '@shared/utils'
  import '@/components/Icons/sync'
  import '@/components/Icons/refresh'

  const initialForm = (config) => {
    const {
      allProxy,
      allProxyBackup,
      autoCheckUpdate,
      btTracker,
      hideAppMenu,
      lastCheckUpdateTime,
      useProxy,
      userAgent
    } = config
    const result = {
      allProxy,
      allProxyBackup,
      autoCheckUpdate,
      btTracker: convertCommaToLine(btTracker),
      hideAppMenu,
      lastCheckUpdateTime,
      useProxy,
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
      const form = initialForm(this.$store.state.preference.config)
      return {
        form,
        formLabelWidth: '23%',
        formOriginal: cloneDeep(form),
        rules: {},
        trackerSyncing: false
      }
    },
    computed: {
      title: function () {
        return this.$t('preferences.advanced')
      },
      showHideAppMenuOption: function () {
        return is.windows() || is.linux()
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
      syncTrackerFromGitHub () {
        this.trackerSyncing = true
        this.$store.dispatch('preference/fetchBtTracker')
          .then((data) => {
            console.log('syncTrackerFromGitHub data====>', data)
            this.form.btTracker = data
          })
          .finally(() => {
            this.trackerSyncing = false
          })
      },
      onUseProxyChange (flag) {
        this.form.allProxy = flag ? this.form.allProxyBackup : ''
      },
      onAllProxyBackupChange (value) {
        this.form.allProxy = value
      },
      changeUA (type) {
        const ua = userAgentMap[type]
        if (!ua) {
          return
        }
        this.form.userAgent = ua
      },
      onFactoryResetClick () {
        this.$electron.remote.dialog.showMessageBox({
          type: 'warning',
          title: this.$t('preferences.factory-reset'),
          message: this.$t('preferences.factory-reset-confirm'),
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
          const changed = diffConfig(this.formOriginal, this.form)
          const data = {
            ...changed,
            btTracker: convertLineToComma(this.form.btTracker)
          }
          console.log('changed====》', data)

          this.$store.dispatch('preference/save', data)
            .then(() => {
              this.$store.dispatch('app/fetchEngineOptions')
              this.$msg.success(this.$t('preferences.save-success-message'))
            })
            .catch(() => {
              this.$msg.success(this.$t('preferences.save-fail-message'))
            })

          if (this.isRenderer()) {
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
.bt-tracker {
  position: relative;
  .sync-tracker {
    position: absolute;
    top: 8px;
    right: 8px;
  }
}
.ua-group {
  margin-top: 8px;
}
</style>
