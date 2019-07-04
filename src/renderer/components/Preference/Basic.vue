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
        <el-form-item :label="`${$t('preferences.appearance')}: `" :label-width="formLabelWidth">
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
        </el-form-item>
        <el-form-item :label="`${$t('preferences.language')}: `" :label-width="formLabelWidth">
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
        <el-form-item :label="`${$t('preferences.startup')}: `" :label-width="formLabelWidth">
          <el-col
            class="form-item-sub"
            :span="24"
            v-if="!isLinux()"
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
        <el-form-item :label="`${$t('preferences.default-dir')}: `" :label-width="formLabelWidth">
          <el-input placeholder="" v-model="downloadDir" :readonly="isMas()">
            <mo-select-directory
              v-if="isRenderer()"
              slot="append"
              @selected="onDirectorySelected"
            />
          </el-input>
          <div class="el-form-item__info" v-if="isMas()" style="margin-top: 8px;">
            {{ $t('preferences.mas-default-dir-tips') }}
          </div>
        </el-form-item>
        <el-form-item :label="`${$t('preferences.transfer-settings')}: `" :label-width="formLabelWidth">
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
  import { cloneDeep } from 'lodash'
  import SelectDirectory from '@/components/Native/SelectDirectory'
  import ThemeSwitcher from '@/components/Preference/ThemeSwitcher'
  import { availableLanguages, getLanguage } from '@shared/locales'
  import { getLocaleManager } from '@/components/Locale'
  import { prettifyDir } from '@/components/Native/utils'
  import {
    calcFormLabelWidth,
    diffConfig,
    checkIsNeedRestart
  } from '@shared/utils'

  const initialForm = (config) => {
    const {
      dir,
      hideAppMenu,
      keepWindowState,
      locale,
      maxConcurrentDownloads,
      maxConnectionPerServer,
      maxOverallUploadLimit,
      maxOverallDownloadLimit,
      newTaskShowDownloading,
      openAtLogin,
      resumeAllWhenAppLaunched,
      split,
      taskNotification,
      theme
    } = config
    const result = {
      continue: config.continue,
      dir,
      hideAppMenu,
      keepWindowState,
      locale,
      maxConcurrentDownloads,
      maxConnectionPerServer,
      maxOverallUploadLimit,
      maxOverallDownloadLimit,
      newTaskShowDownloading,
      openAtLogin,
      resumeAllWhenAppLaunched,
      split,
      taskNotification,
      theme
    }
    return result
  }

  export default {
    name: 'mo-preference-basic',
    components: {
      [SelectDirectory.name]: SelectDirectory,
      [ThemeSwitcher.name]: ThemeSwitcher
    },
    data: function () {
      const { locale } = this.$store.state.preference.config
      const form = initialForm(this.$store.state.preference.config)
      const formOriginal = cloneDeep(form)

      return {
        form,
        formLabelWidth: calcFormLabelWidth(locale),
        formOriginal,
        locales: availableLanguages,
        rules: {},
        speedOptions: this.buildSpeedOptions()
      }
    },
    computed: {
      title: function () {
        return this.$t('preferences.basic')
      },
      showHideAppMenuOption: function () {
        return is.windows() || is.linux()
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
      isLinux: is.linux,
      handleLocaleChange (locale) {
        const lng = getLanguage(locale)
        getLocaleManager().changeLanguage(lng)
        this.speedOptions = this.buildSpeedOptions()
        this.$electron.ipcRenderer.send('command', 'application:change-locale', lng)
      },
      handleThemeChange (theme) {
        this.form.theme = theme
        this.$electron.ipcRenderer.send('command', 'application:change-theme', theme)
      },
      buildSpeedOptions () {
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
            label: '512 KB/s',
            value: '512K'
          },
          {
            label: '1 MB/s',
            value: '1M'
          },
          {
            label: '5 MB/s',
            value: '5M'
          },
          {
            label: '10 MB/s',
            value: '10M'
          }
        ]
      },
      onDirectorySelected (dir) {
        this.form.dir = dir
      },
      syncFormConfig () {
        this.$store.dispatch('preference/fetchPreference')
          .then((config) => {
            this.form = initialForm(config)
            this.formOriginal = cloneDeep(this.form)
          })
      },
      submitForm (formName) {
        this.$refs[formName].validate((valid) => {
          if (!valid) {
            console.log('error submit!!')
            return false
          }

          const { openAtLogin } = this.form
          const changed = diffConfig(this.formOriginal, this.form)
          const data = {
            ...changed
          }
          console.log('changed====》', data)

          this.$store.dispatch('preference/save', data)
            .then(() => {
              this.$store.dispatch('app/fetchEngineOptions')
              this.syncFormConfig()
              this.$msg.success(this.$t('preferences.save-success-message'))
            })
            .catch(() => {
              this.$msg.success(this.$t('preferences.save-fail-message'))
            })

          if (this.isRenderer()) {
            this.$electron.ipcRenderer.send('command', 'application:open-at-login', openAtLogin)

            if (checkIsNeedRestart(changed)) {
              this.$electron.ipcRenderer.send('command', 'application:relaunch')
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

<style lang="scss">
</style>
