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
        <el-form-item :label="`${$t('preferences.download-protocol')}: `" :label-width="formLabelWidth">
          {{ $t('preferences.protocols-default-client') }}
          <el-col class="form-item-sub" :span="24">
            <el-switch
              v-model="form.protocols.magnet"
              :active-text="$t('preferences.protocols-magnet')"
              >
            </el-switch>
          </el-col>
          <el-col class="form-item-sub" :span="24">
            <el-switch
              v-model="form.protocols.thunder"
              :active-text="$t('preferences.protocols-thunder')"
              >
            </el-switch>
          </el-col>
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
  import '@/components/Icons/info-square'
  import {
    calcFormLabelWidth
  } from '@shared/utils'

  const initialForm = (config) => {
    const {
      protocols
    } = config
    const result = {
      protocols
    }
    return result
  }

  export default {
    name: 'mo-preference-lab',
    components: {
    },
    data: function () {
      const { locale } = this.$store.state.preference.config
      const form = initialForm(this.$store.state.preference.config)
      return {
        form,
        formLabelWidth: calcFormLabelWidth(locale),
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
