<template>
  <el-container class="content panel" direction="vertical">
    <el-header class="panel-header" height="84">
      <h4>{{ title }}</h4>
    </el-header>
    <el-main class="panel-content">
      <el-form
        class="form-preference"
        ref="labForm"
        label-position="right"
        size="mini"
        :model="form"
        :rules="rules">
        <el-form-item :label-width="formLabelWidth">
          <div class="el-form-item__error">
            {{ $t('preferences.lab-warning') }}
          </div>
        </el-form-item>
        <el-form-item :label="`${$t('preferences.browser-extensions')}: `" :label-width="formLabelWidth">
          <el-col class="form-item-sub" :span="24">
            <a target="_blank" href="https://motrix.app/release/BaiduExporter.zip" rel="noopener noreferrer">
              {{ $t('preferences.baidu-exporter') }}
              <mo-icon name="link" width="12" height="12" />
            </a>
            <div class="el-form-item__info" style="margin-top: 8px;">
              {{ $t('preferences.browser-extensions-tips') }}
              <a target="_blank" href="https://motrix.app/extensions/baidu" rel="noopener noreferrer">
                {{ $t('preferences.baidu-exporter-help') }}
              </a>
            </div>
          </el-col>
        </el-form-item>
      </el-form>
      <div class="form-actions">
        <el-button type="primary" @click="submitForm('labForm')">{{ $t('preferences.save') }}</el-button>
        <el-button @click="resetForm('labForm')">{{ $t('preferences.discard') }}</el-button>
      </div>
    </el-main>
  </el-container>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'
  import { cloneDeep } from 'lodash'
  import '@/components/Icons/info-square'
  import {
    calcFormLabelWidth,
    diffConfig
  } from '@shared/utils'

  const initialForm = (config) => {
    // const {
    // } = config
    const result = {
    }
    return result
  }

  export default {
    name: 'mo-preference-lab',
    data: function () {
      const { locale } = this.$store.state.preference.config
      const form = initialForm(this.$store.state.preference.config)
      const formOriginal = cloneDeep(form)

      return {
        form,
        formLabelWidth: calcFormLabelWidth(locale),
        formOriginal,
        rules: {}
      }
    },
    computed: {
      title: function () {
        return this.$t('preferences.lab')
      },
      ...mapState('preference', {
        config: state => state.config
      })
    },
    methods: {
      isRenderer: is.renderer,
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
