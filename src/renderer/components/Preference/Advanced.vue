<template>
  <el-container class="content panel" direction="vertical">
    <el-header class="panel-header" height="84">
      <h4 class="hidden-xs-only">{{ title }}</h4>
      <mo-subnav-switcher
        :title="title"
        :subnavs="subnavs"
        class="hidden-sm-and-up"
      />
    </el-header>
    <el-main class="panel-content">
      <el-form
        class="form-preference"
        ref="advancedForm"
        label-position="right"
        size="mini"
        :model="form"
        :rules="rules"
      >
        <el-form-item
          :label="`${$t('preferences.auto-update')}: `"
          :label-width="formLabelWidth"
        >
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.autoCheckUpdate">
              {{ $t('preferences.auto-check-update') }}
            </el-checkbox>
            <div
              class="el-form-item__info"
              style="margin-top: 8px;"
              v-if="form.lastCheckUpdateTime !== 0"
            >
              {{
                $t('preferences.last-check-update-time') + ': ' +
                (
                  form.lastCheckUpdateTime !== 0 ?
                    new Date(form.lastCheckUpdateTime).toLocaleString() :
                    new Date().toLocaleString()
                )
              }}
              <span class="action-link" @click.prevent="onCheckUpdateClick">
                {{ $t('app.check-updates-now') }}
              </span>
            </div>
          </el-col>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.proxy')}: `"
          :label-width="formLabelWidth"
        >
          <el-switch
            v-model="form.useProxy"
            :active-text="$t('preferences.use-proxy')"
            @change="onUseProxyChange"
            >
          </el-switch>
        </el-form-item>
        <el-form-item
          :label-width="formLabelWidth"
          v-if="form.useProxy"
          style="margin-top: -16px;"
        >
          <el-col
            class="form-item-sub"
            :xs="24"
            :sm="20"
            :md="16"
            :lg="16"
          >
            <el-input
              placeholder="[http://][USER:PASSWORD@]HOST[:PORT]"
              @change="onAllProxyBackupChange"
              v-model="form.allProxyBackup">
            </el-input>
          </el-col>
          <el-col
            class="form-item-sub"
            :xs="24"
            :sm="24"
            :md="20"
            :lg="20"
          >
            <el-input
              type="textarea"
              rows="2"
              auto-complete="off"
              :placeholder="`${$t('preferences.no-proxy-input-tips')}`"
              v-model="form.noProxy">
            </el-input>
            <div class="el-form-item__info" style="margin-top: 8px;">
              <a target="_blank" href="https://github.com/agalwood/Motrix/wiki/Proxy" rel="noopener noreferrer">
                {{ $t('preferences.proxy-tips') }}
                <mo-icon name="link" width="12" height="12" />
              </a>
            </div>
          </el-col>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.bt-tracker')}: `"
          :label-width="formLabelWidth"
        >
          <div class="form-item-sub bt-tracker">
            <el-row :gutter="10" style="line-height: 0;">
              <el-col :span="20">
                <div class="track-source">
                  <el-select
                    class="select-track-source"
                    v-model="form.trackerSource"
                    allow-create
                    filterable
                    multiple
                  >
                    <el-option-group
                      v-for="group in trackerSourceOptions"
                      :key="group.label"
                      :label="group.label"
                    >
                      <el-option
                        v-for="item in group.options"
                        :key="item.value"
                        :label="item.label"
                        :value="item.value"
                      >
                        <span style="float: left">{{ item.label }}</span>
                        <span style="float: right; margin-right: 24px">
                          <el-tag
                            type="success"
                            size="mini"
                            v-if="item.cdn"
                          >
                            CDN
                          </el-tag>
                        </span>
                      </el-option>
                    </el-option-group>
                  </el-select>
                </div>
              </el-col>
              <el-col :span="3">
                <div class="sync-tracker">
                  <el-tooltip
                    class="item"
                    effect="dark"
                    :content="$t('preferences.sync-tracker-tips')"
                    placement="bottom"
                  >
                    <el-button
                      @click="syncTrackerFromSource"
                      class="sync-tracker-btn"
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
              </el-col>
            </el-row>
            <el-input
              type="textarea"
              rows="3"
              auto-complete="off"
              :placeholder="`${$t('preferences.bt-tracker-input-tips')}`"
              v-model="form.btTracker">
            </el-input>
            <div class="el-form-item__info" style="margin-top: 8px;">
              {{ $t('preferences.bt-tracker-tips') }}
              <a target="_blank" href="https://github.com/ngosang/trackerslist" rel="noopener noreferrer">
                ngosang/trackerslist
                <mo-icon name="link" width="12" height="12" />
              </a>
              <a target="_blank" href="https://github.com/XIU2/TrackersListCollection" rel="noopener noreferrer">
                XIU2/TrackersListCollection
                <mo-icon name="link" width="12" height="12" />
              </a>
            </div>
          </div>
          <div class="form-item-sub">
            <el-checkbox v-model="form.autoSyncTracker">
              {{ $t('preferences.auto-sync-tracker') }}
            </el-checkbox>
            <div class="el-form-item__info" style="margin-top: 8px;" v-if="form.lastSyncTrackerTime > 0">
              {{ new Date(form.lastSyncTrackerTime).toLocaleString() }}
            </div>
          </div>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.rpc')}: `"
          :label-width="formLabelWidth"
        >
          <el-row style="margin-bottom: 8px;">
            <el-col
              class="form-item-sub"
              :xs="24"
              :sm="18"
              :md="10"
              :lg="10"
            >
              {{ $t('preferences.rpc-listen-port') }}
              <el-input
                :placeholder="rpcDefaultPort"
                :maxlength="8"
                v-model="form.rpcListenPort"
                @change="onRpcListenPortChange"
              >
                <i slot="append" @click.prevent="onRpcPortDiceClick">
                  <mo-icon name="dice" width="12" height="12" />
                </i>
              </el-input>
            </el-col>
          </el-row>
          <el-row style="margin-bottom: 8px;">
            <el-col
              class="form-item-sub"
              :xs="24"
              :sm="18"
              :md="18"
              :lg="18"
            >
              {{ $t('preferences.rpc-secret') }}
              <el-input
                :show-password="hideRpcSecret"
                placeholder="RPC Secret"
                :maxlength="64"
                v-model="form.rpcSecret"
              >
                <i slot="append" @click.prevent="onRpcSecretDiceClick">
                  <mo-icon name="dice" width="12" height="12" />
                </i>
              </el-input>
              <div class="el-form-item__info" style="margin-top: 8px;">
                <a target="_blank" href="https://github.com/agalwood/Motrix/wiki/RPC" rel="noopener noreferrer">
                  {{ $t('preferences.rpc-secret-tips') }}
                  <mo-icon name="link" width="12" height="12" />
                </a>
              </div>
            </el-col>
          </el-row>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.port')}: `"
          :label-width="formLabelWidth"
        >
          <el-row style="margin-bottom: 8px;">
            <el-col
              class="form-item-sub"
              :xs="24"
              :sm="18"
              :md="12"
              :lg="12"
            >
              <el-switch
                v-model="form.enableUpnp"
                active-text="UPnP/NAT-PMP"
                >
              </el-switch>
            </el-col>
          </el-row>
          <el-row style="margin-bottom: 8px;">
            <el-col class="form-item-sub"
              :xs="24"
              :sm="18"
              :md="10"
              :lg="10"
            >
              {{ $t('preferences.bt-port') }}
              <el-input
                placeholder="BT Port"
                :maxlength="8"
                v-model="form.listenPort"
              >
                <i slot="append" @click.prevent="onBtPortDiceClick">
                  <mo-icon name="dice" width="12" height="12" />
                </i>
              </el-input>
            </el-col>
          </el-row>
          <el-row>
            <el-col
              class="form-item-sub"
              :xs="24"
              :sm="18"
              :md="10"
              :lg="10"
            >
              {{ $t('preferences.dht-port') }}
              <el-input
                placeholder="DHT Port"
                :maxlength="8"
                v-model="form.dhtListenPort"
              >
                <i slot="append" @click.prevent="onDhtPortDiceClick">
                  <mo-icon name="dice" width="12" height="12" />
                </i>
              </el-input>
            </el-col>
          </el-row>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.download-protocol')}: `"
          :label-width="formLabelWidth"
        >
          {{ $t('preferences.protocols-default-client') }}
          <el-col class="form-item-sub" :span="24">
            <el-switch
              v-model="form.protocols.magnet"
              :active-text="$t('preferences.protocols-magnet')"
              @change="(val) => onProtocolsChange('magnet', val)"
              >
            </el-switch>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-switch
              v-model="form.protocols.thunder"
              :active-text="$t('preferences.protocols-thunder')"
              @change="(val) => onProtocolsChange('thunder', val)"
              >
            </el-switch>
          </el-col>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.user-agent')}: `"
          :label-width="formLabelWidth"
        >
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.mock-user-agent') }}
            <el-input
              type="textarea"
              rows="2"
              auto-complete="off"
              placeholder="User-Agent"
              v-model="form.userAgent">
            </el-input>
            <el-button-group class="ua-group">
              <el-button @click="() => changeUA('aria2')">Aria2</el-button>
              <el-button @click="() => changeUA('transmission')">Transmission</el-button>
              <el-button @click="() => changeUA('chrome')">Chrome</el-button>
              <el-button @click="() => changeUA('du')">du</el-button>
            </el-button-group>
          </el-col>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.developer')}: `"
          :label-width="formLabelWidth"
        >
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.aria2-conf-path') }}
            <el-input placeholder="" disabled v-model="aria2ConfPath">
              <mo-show-in-folder
                slot="append"
                v-if="isRenderer"
                :path="aria2ConfPath"
              />
            </el-input>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.download-session-path') }}
            <el-input placeholder="" disabled v-model="sessionPath">
              <mo-show-in-folder
                slot="append"
                v-if="isRenderer"
                :path="sessionPath"
              />
            </el-input>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.app-log-path') }}
            <el-row :gutter="16">
              <el-col :span="18">
                <el-input placeholder="" disabled v-model="logPath">
                  <mo-show-in-folder
                  slot="append"
                  v-if="isRenderer"
                  :path="logPath"
                  />
                </el-input>
              </el-col>
              <el-col :span="6">
                <el-select v-model="form.logLevel">
                  <el-option
                    v-for="item in logLevels"
                    :key="item"
                    :label="item"
                    :value="item">
                  </el-option>
                </el-select>
              </el-col>
            </el-row>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-button plain type="warning" @click="() => onSessionResetClick()">
              {{ $t('preferences.session-reset') }}
            </el-button>
            <el-button plain type="danger" @click="() => onFactoryResetClick()">
              {{ $t('preferences.factory-reset') }}
            </el-button>
          </el-col>
        </el-form-item>
      </el-form>
      <div class="form-actions">
        <el-button
          type="primary"
          @click="submitForm('advancedForm')"
        >
          {{ $t('preferences.save') }}
        </el-button>
        <el-button
          @click="resetForm('advancedForm')"
        >
          {{ $t('preferences.discard') }}
        </el-button>
      </div>
    </el-main>
  </el-container>
</template>

<script>
  import is from 'electron-is'
  import { dialog } from '@electron/remote'
  import { mapState } from 'vuex'
  import { cloneDeep, extend, isEmpty } from 'lodash'
  import randomize from 'randomatic'
  import ShowInFolder from '@/components/Native/ShowInFolder'
  import SubnavSwitcher from '@/components/Subnav/SubnavSwitcher'
  import userAgentMap from '@shared/ua'
  import {
    EMPTY_STRING,
    ENGINE_RPC_PORT,
    LOG_LEVELS,
    trackerSourceOptions
  } from '@shared/constants'
  import {
    backupConfig,
    buildRpcUrl,
    calcFormLabelWidth,
    changedConfig,
    checkIsNeedRestart,
    convertCommaToLine,
    convertLineToComma,
    diffConfig,
    generateRandomInt
  } from '@shared/utils'
  import { convertTrackerDataToLine, reduceTrackerString } from '@shared/utils/tracker'
  import '@/components/Icons/dice'
  import '@/components/Icons/sync'
  import '@/components/Icons/refresh'
  import { getLanguage } from '@shared/locales'
  import { getLocaleManager } from '@/components/Locale'

  const initForm = (config) => {
    const {
      allProxy,
      allProxyBackup,
      autoCheckUpdate,
      autoSyncTracker,
      btTracker,
      dhtListenPort,
      enableUpnp,
      hideAppMenu,
      lastCheckUpdateTime,
      lastSyncTrackerTime,
      listenPort,
      logLevel,
      noProxy,
      protocols,
      rpcListenPort,
      rpcSecret,
      trackerSource,
      useProxy,
      userAgent
    } = config
    const result = {
      allProxy,
      allProxyBackup,
      autoCheckUpdate,
      autoSyncTracker,
      btTracker: convertCommaToLine(btTracker),
      dhtListenPort,
      enableUpnp,
      hideAppMenu,
      lastCheckUpdateTime,
      lastSyncTrackerTime,
      listenPort,
      logLevel,
      noProxy: convertCommaToLine(noProxy),
      protocols: { ...protocols },
      rpcListenPort,
      rpcSecret,
      trackerSource,
      useProxy,
      userAgent
    }
    return result
  }

  export default {
    name: 'mo-preference-advanced',
    components: {
      [SubnavSwitcher.name]: SubnavSwitcher,
      [ShowInFolder.name]: ShowInFolder
    },
    data () {
      const { locale } = this.$store.state.preference.config
      const formOriginal = initForm(this.$store.state.preference.config)
      let form = {}
      form = initForm(extend(form, formOriginal, changedConfig.advanced))

      return {
        form,
        formLabelWidth: calcFormLabelWidth(locale),
        formOriginal,
        hideRpcSecret: true,
        rules: {},
        trackerSourceOptions,
        trackerSyncing: false
      }
    },
    computed: {
      isRenderer: () => is.renderer(),
      title () {
        return this.$t('preferences.advanced')
      },
      subnavs () {
        return [
          {
            key: 'basic',
            title: this.$t('preferences.basic'),
            route: '/preference/basic'
          },
          {
            key: 'advanced',
            title: this.$t('preferences.advanced'),
            route: '/preference/advanced'
          },
          {
            key: 'lab',
            title: this.$t('preferences.lab'),
            route: '/preference/lab'
          }
        ]
      },
      rpcDefaultPort () {
        return ENGINE_RPC_PORT
      },
      logLevels () {
        return LOG_LEVELS
      },
      ...mapState('preference', {
        config: state => state.config,
        aria2ConfPath: state => state.config.aria2ConfPath,
        logPath: state => state.config.logPath,
        sessionPath: state => state.config.sessionPath
      })
    },
    watch: {
      'form.rpcListenPort' (val) {
        const url = buildRpcUrl({
          port: this.form.rpcListenPort,
          secret: val
        })
        navigator.clipboard.writeText(url)
      },
      'form.rpcSecret' (val) {
        const url = buildRpcUrl({
          port: this.form.rpcListenPort,
          secret: val
        })
        navigator.clipboard.writeText(url)
      }
    },
    methods: {
      handleLocaleChange (locale) {
        const lng = getLanguage(locale)
        getLocaleManager().changeLanguage(lng)
        this.$electron.ipcRenderer.send('command',
                                        'application:change-locale', lng)
      },
      onCheckUpdateClick () {
        this.$electron.ipcRenderer.send('command', 'application:check-for-updates')
        this.$msg.info(this.$t('app.checking-for-updates'))
        this.$store.dispatch('preference/fetchPreference')
          .then((config) => {
            const { lastCheckUpdateTime } = config
            this.form.lastCheckUpdateTime = lastCheckUpdateTime
          })
      },
      syncTrackerFromSource () {
        this.trackerSyncing = true
        const { trackerSource } = this.form
        this.$store.dispatch('preference/fetchBtTracker', trackerSource)
          .then((data) => {
            const tracker = convertTrackerDataToLine(data)
            this.form.lastSyncTrackerTime = Date.now()
            this.form.btTracker = tracker
            this.trackerSyncing = false
          })
          .catch((_) => {
            this.trackerSyncing = false
          })
      },
      onProtocolsChange (protocol, enabled) {
        const { protocols } = this.form
        this.form.protocols = {
          ...protocols,
          [protocol]: enabled
        }
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
      onBtPortDiceClick () {
        const port = generateRandomInt(20000, 24999)
        this.form.listenPort = port
      },
      onDhtPortDiceClick () {
        const port = generateRandomInt(25000, 29999)
        this.form.dhtListenPort = port
      },
      onRpcListenPortChange (value) {
        console.log('onRpcListenPortChange===>', value)
        if (EMPTY_STRING === value) {
          this.form.rpcListenPort = this.rpcDefaultPort
        }
      },
      onRpcPortDiceClick () {
        const port = generateRandomInt(ENGINE_RPC_PORT, 20000)
        this.form.rpcListenPort = port
      },
      onRpcSecretDiceClick () {
        this.hideRpcSecret = false
        const rpcSecret = randomize('Aa0', 16)
        this.form.rpcSecret = rpcSecret

        setTimeout(() => {
          this.hideRpcSecret = true
        }, 2000)
      },
      onSessionResetClick () {
        dialog.showMessageBox({
          type: 'warning',
          title: this.$t('preferences.session-reset'),
          message: this.$t('preferences.session-reset-confirm'),
          buttons: [this.$t('app.yes'), this.$t('app.no')],
          cancelId: 1
        }).then(({ response }) => {
          if (response === 0) {
            this.$store.dispatch('task/purgeTaskRecord')
            this.$store.dispatch('task/pauseAllTask')
              .then(() => {
                this.$electron.ipcRenderer.send('command', 'application:reset-session')
              })
          }
        })
      },
      onFactoryResetClick () {
        dialog.showMessageBox({
          type: 'warning',
          title: this.$t('preferences.factory-reset'),
          message: this.$t('preferences.factory-reset-confirm'),
          buttons: [this.$t('app.yes'), this.$t('app.no')],
          cancelId: 1
        }).then(({ response }) => {
          if (response === 0) {
            this.$electron.ipcRenderer.send('command', 'application:reset')
          }
        })
      },
      syncFormConfig () {
        this.$store.dispatch('preference/fetchPreference')
          .then((config) => {
            this.form = initForm(config)
            this.formOriginal = cloneDeep(this.form)
            if (changedConfig.basic.theme !== undefined) {
              this.$electron.ipcRenderer.send('command',
                                              'application:change-theme', changedConfig.basic.theme)
            }
          })
      },
      submitForm (formName) {
        this.$refs[formName].validate((valid) => {
          if (!valid) {
            console.error('[Motrix] preference form valid:', valid)
            return false
          }

          const data = {
            ...diffConfig(this.formOriginal, this.form),
            ...changedConfig.basic
          }

          const {
            btAutoDownloadContent,
            autoHideWindow,
            btTracker,
            noProxy,
            rpcListenPort
          } = data

          if ('btAutoDownloadContent' in data) {
            data.followTorrent = btAutoDownloadContent
            data.followMetalink = btAutoDownloadContent
            data.pauseMetadata = !btAutoDownloadContent
          }

          if (btTracker) {
            data.btTracker = reduceTrackerString(convertLineToComma(btTracker))
          }

          if (noProxy) {
            data.noProxy = convertLineToComma(noProxy)
          }

          if (rpcListenPort === EMPTY_STRING) {
            data.rpcListenPort = this.rpcDefaultPort
          }

          console.log('[Motrix] preference changed data:', data)

          this.$store.dispatch('preference/save', data)
            .then(() => {
              this.$store.dispatch('app/fetchEngineOptions')
              this.syncFormConfig()
              this.$msg.success(this.$t('preferences.save-success-message'))
            })
            .catch((e) => {
              this.$msg.success(this.$t('preferences.save-fail-message'))
            })

          changedConfig.basic = {}
          changedConfig.advanced = {}

          if (this.isRenderer) {
            if ('autoHideWindow' in data) {
              this.$electron.ipcRenderer.send('command',
                                              'application:auto-hide-window', autoHideWindow)
            }

            if (checkIsNeedRestart(data)) {
              this.$electron.ipcRenderer.send('command', 'application:relaunch')
            }
          }
        })
      },
      resetForm (formName) {
        this.syncFormConfig()
      }
    },
    beforeRouteLeave (to, from, next) {
      changedConfig.advanced = diffConfig(this.formOriginal, this.form)
      if (to.path === '/preference/basic') {
        next()
      } else {
        if (isEmpty(changedConfig.basic) && isEmpty(changedConfig.advanced)) {
          next()
        } else {
          dialog.showMessageBox({
            type: 'warning',
            title: this.$t('preferences.not-saved'),
            message: this.$t('preferences.not-saved-confirm'),
            buttons: [this.$t('app.yes'), this.$t('app.no')],
            cancelId: 1
          }).then(({ response }) => {
            if (response === 0) {
              if (changedConfig.basic.theme !== undefined) {
                this.$electron.ipcRenderer.send('command',
                                                'application:change-theme',
                                                backupConfig.theme)
              }
              if (changedConfig.basic.locale !== undefined) {
                this.handleLocaleChange(backupConfig.locale)
              }
              changedConfig.basic = {}
              changedConfig.advanced = {}
              backupConfig.theme = undefined
              next()
            }
          })
        }
      }
    }
  }
</script>

<style lang="scss">
.bt-tracker {
  position: relative;
  .sync-tracker-btn {
    line-height: 0;
  }
  .track-source {
    margin-bottom: 16px;
    .select-track-source {
      width: 100%;
    }
    .el-select__tags {
      overflow-x: auto;
    }
  }
}
.ua-group {
  margin-top: 8px;
}
</style>
