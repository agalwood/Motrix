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
        ref="basicForm"
        label-position="right"
        size="mini"
        :model="form"
        :rules="rules"
      >
        <el-form-item
          :label="`${$t('preferences.appearance')}: `"
          :label-width="formLabelWidth"
        >
          <el-col class="form-item-sub" :span="24">
            <mo-theme-switcher
              v-model="form.theme"
              @change="handleThemeChange"
            />
          </el-col>
          <el-col v-if="showHideAppMenuOption" class="form-item-sub" :span="16">
            <el-checkbox v-model="form.hideAppMenu">
              {{ $t('preferences.hide-app-menu') }}
            </el-checkbox>
          </el-col>
          <el-col class="form-item-sub" :span="16">
            <el-checkbox v-model="form.autoHideWindow">
              {{ $t('preferences.auto-hide-window') }}
            </el-checkbox>
          </el-col>
          <el-col v-if="isMac" class="form-item-sub" :span="16">
            <el-checkbox v-model="form.traySpeedometer">
              {{ $t('preferences.tray-speedometer') }}
            </el-checkbox>
          </el-col>
        </el-form-item>
        <el-form-item
          v-if="isMac"
          :label="`${$t('preferences.run-mode')}: `"
          :label-width="formLabelWidth"
        >
          <el-col class="form-item-sub" :span="24">
            <el-select v-model="form.runMode">
              <el-option
                v-for="item in runModes"
                :key="item.value"
                :label="item.label"
                :value="item.value">
              </el-option>
            </el-select>
          </el-col>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.language')}: `"
          :label-width="formLabelWidth"
        >
          <el-col class="form-item-sub" :span="16">
            <el-select
              v-model="form.locale"
              @change="handleLocaleChange"
              :placeholder="$t('preferences.change-language')">
              <el-option
                v-for="item in locales"
                :key="item.value"
                :label="item.label"
                :value="item.value">
              </el-option>
            </el-select>
          </el-col>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.startup')}: `"
          :label-width="formLabelWidth"
        >
          <el-col
            class="form-item-sub"
            :span="24"
            v-if="!isLinux"
          >
            <el-checkbox v-model="form.openAtLogin">
              {{ $t('preferences.open-at-login') }}
            </el-checkbox>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.keepWindowState">
              {{ $t('preferences.keep-window-state') }}
            </el-checkbox>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.resumeAllWhenAppLaunched">
              {{ $t('preferences.auto-resume-all') }}
            </el-checkbox>
          </el-col>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.default-dir')}: `"
          :label-width="formLabelWidth"
        >
          <el-input placeholder="" v-model="form.dir" :readonly="isMas">
            <mo-select-directory
              v-if="isRenderer"
              slot="append"
              @selected="onDirectorySelected"
            />
          </el-input>
          <div class="el-form-item__info" v-if="isMas" style="margin-top: 8px;">
            {{ $t('preferences.mas-default-dir-tips') }}
          </div>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.transfer-settings')}: `"
          :label-width="formLabelWidth"
        >
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.transfer-speed-upload') }}
            <el-select v-model="form.maxOverallUploadLimit">
              <el-option
                v-for="item in speedOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value">
              </el-option>
            </el-select>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            {{ $t('preferences.transfer-speed-download') }}
            <el-select v-model="form.maxOverallDownloadLimit">
              <el-option
                v-for="item in speedOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value">
              </el-option>
            </el-select>
          </el-col>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.bt-settings')}: `"
          :label-width="formLabelWidth"
        >
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.btSaveMetadata">
              {{ $t('preferences.bt-save-metadata') }}
            </el-checkbox>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-switch
              v-model="form.keepSeeding"
              :active-text="$t('preferences.keep-seeding')"
              @change="onKeepSeedingChange"
            >
            </el-switch>
          </el-col>
          <el-col class="form-item-sub" :span="24" v-if="!form.keepSeeding">
            {{ $t('preferences.seed-ratio') }}
            <el-input-number
              v-model="form.seedRatio"
              controls-position="right"
              :min="1"
              :max="100"
              :step="0.1"
              :label="$t('preferences.seed-ratio')">
            </el-input-number>
          </el-col>
          <el-col class="form-item-sub" :span="24" v-if="!form.keepSeeding">
            {{ $t('preferences.seed-time') }}
            ({{ $t('preferences.seed-time-unit') }})
            <el-input-number
              v-model="form.seedTime"
              controls-position="right"
              :min="60"
              :max="525600"
              :step="1"
              :label="$t('preferences.seed-time')">
            </el-input-number>
          </el-col>
          <div class="el-form-item__info" style="margin-top: 8px;">
          </div>
        </el-form-item>
        <el-form-item
          :label="`${$t('preferences.task-manage')}: `"
          :label-width="formLabelWidth"
        >
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
              v-model="form.maxConnectionPerServer"
              controls-position="right"
              :min="1"
              :max="form.engineMaxConnectionPerServer"
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
          <el-col class="form-item-sub" :span="24">
            <el-checkbox v-model="form.noConfirmBeforeDeleteTask">
              {{ $t('preferences.no-confirm-before-delete-task') }}
            </el-checkbox>
          </el-col>
        </el-form-item>
      </el-form>
      <div class="form-actions">
        <el-button
          type="primary"
          @click="submitForm('basicForm')"
        >
          {{ $t('preferences.save') }}
        </el-button>
        <el-button
          @click="resetForm('basicForm')"
        >
          {{ $t('preferences.discard') }}
        </el-button>
      </div>
    </el-main>
  </el-container>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'
  import { cloneDeep } from 'lodash'
  import SubnavSwitcher from '@/components/Subnav/SubnavSwitcher'
  import SelectDirectory from '@/components/Native/SelectDirectory'
  import ThemeSwitcher from '@/components/Preference/ThemeSwitcher'
  import { availableLanguages, getLanguage } from '@shared/locales'
  import { getLocaleManager } from '@/components/Locale'
  import {
    calcFormLabelWidth,
    checkIsNeedRestart,
    diffConfig
  } from '@shared/utils'
  import { APP_RUN_MODE } from '@shared/constants'

  const initForm = (config) => {
    const {
      autoHideWindow,
      btSaveMetadata,
      dir,
      engineMaxConnectionPerServer,
      hideAppMenu,
      keepSeeding,
      keepWindowState,
      locale,
      maxConcurrentDownloads,
      maxConnectionPerServer,
      maxOverallDownloadLimit,
      maxOverallUploadLimit,
      newTaskShowDownloading,
      noConfirmBeforeDeleteTask,
      openAtLogin,
      resumeAllWhenAppLaunched,
      runMode,
      seedRatio,
      seedTime,
      taskNotification,
      theme,
      traySpeedometer
    } = config
    const result = {
      autoHideWindow,
      btSaveMetadata,
      continue: config.continue,
      dir,
      engineMaxConnectionPerServer,
      hideAppMenu,
      keepSeeding,
      keepWindowState,
      locale,
      maxConcurrentDownloads,
      maxConnectionPerServer,
      maxOverallDownloadLimit,
      maxOverallUploadLimit,
      newTaskShowDownloading,
      noConfirmBeforeDeleteTask,
      openAtLogin,
      resumeAllWhenAppLaunched,
      runMode,
      seedRatio,
      seedTime,
      taskNotification,
      theme,
      traySpeedometer
    }
    return result
  }

  export default {
    name: 'mo-preference-basic',
    components: {
      [SubnavSwitcher.name]: SubnavSwitcher,
      [SelectDirectory.name]: SelectDirectory,
      [ThemeSwitcher.name]: ThemeSwitcher
    },
    data () {
      const { locale } = this.$store.state.preference.config
      const form = initForm(this.$store.state.preference.config)
      const formOriginal = cloneDeep(form)

      return {
        form,
        formLabelWidth: calcFormLabelWidth(locale),
        formOriginal,
        locales: availableLanguages,
        rules: {}
      }
    },
    computed: {
      isRenderer: () => is.renderer(),
      isMac: () => is.macOS(),
      isMas: () => is.mas(),
      isLinux () { return is.linux() },
      title () {
        return this.$t('preferences.basic')
      },
      runModes () {
        return [
          {
            label: this.$t('preferences.run-mode-standard'),
            value: 1
          },
          {
            label: this.$t('preferences.run-mode-menu-bar'),
            value: 2
          }
        ]
      },
      speedOptions () {
        return [
          {
            label: this.$t('preferences.transfer-speed-unlimited'),
            value: 0
          },
          {
            label: '128 KB/s',
            value: '128K'
          },
          {
            label: '256 KB/s',
            value: '256K'
          },
          {
            label: '512 KB/s',
            value: '512K'
          },
          {
            label: '1 MB/s',
            value: '1M'
          },
          {
            label: '2 MB/s',
            value: '2M'
          },
          {
            label: '3 MB/s',
            value: '3M'
          },
          {
            label: '5 MB/s',
            value: '5M'
          },
          {
            label: '8 MB/s',
            value: '8M'
          },
          {
            label: '10 MB/s',
            value: '10M'
          },
          {
            label: '20 MB/s',
            value: '20M'
          },
          {
            label: '30 MB/s',
            value: '30M'
          }
        ]
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
      showHideAppMenuOption () {
        return is.windows() || is.linux()
      },
      ...mapState('preference', {
        config: state => state.config
      })
    },
    methods: {
      handleLocaleChange (locale) {
        const lng = getLanguage(locale)
        getLocaleManager().changeLanguage(lng)
        this.$electron.ipcRenderer.send('command',
                                        'application:change-locale', lng)
      },
      handleThemeChange (theme) {
        this.form.theme = theme
        this.$electron.ipcRenderer.send('command',
                                        'application:change-theme', theme)
      },
      onKeepSeedingChange (enable) {
        this.form.seedRatio = enable ? 0 : 1
        this.form.seedTime = enable ? 525600 : 60
      },
      onDirectorySelected (dir) {
        this.form.dir = dir
      },
      syncFormConfig () {
        this.$store.dispatch('preference/fetchPreference')
          .then((config) => {
            this.form = initForm(config)
            this.formOriginal = cloneDeep(this.form)
          })
      },
      submitForm (formName) {
        this.$refs[formName].validate((valid) => {
          if (!valid) {
            console.error('[Motrix] preference form valid:', valid)
            return false
          }

          const { runMode, openAtLogin, autoHideWindow } = this.form
          const changed = diffConfig(this.formOriginal, this.form)
          const data = {
            ...changed
          }
          console.log('[Motrix] preference changed data:', data)

          this.$store.dispatch('preference/save', data)
            .then(() => {
              this.$store.dispatch('app/fetchEngineOptions')
              this.syncFormConfig()
              this.$msg.success(this.$t('preferences.save-success-message'))
            })
            .catch(() => {
              this.$msg.success(this.$t('preferences.save-fail-message'))
            })

          if (this.isRenderer) {
            this.$electron.ipcRenderer.send('command',
                                            'application:open-at-login', openAtLogin)

            if ('runMode' in changed) {
              this.$electron.ipcRenderer.send('command',
                                              'application:toggle-dock', runMode === APP_RUN_MODE.STANDARD)
            }

            if ('autoHideWindow' in changed) {
              this.$electron.ipcRenderer.send('command',
                                              'application:auto-hide-window', autoHideWindow)
            }

            if (checkIsNeedRestart(data)) {
              this.$electron.ipcRenderer.send('command',
                                              'application:relaunch')
            }
          }
        })
      },
      resetForm (formName) {
        this.syncFormConfig()
      }
    }
  }
</script>
