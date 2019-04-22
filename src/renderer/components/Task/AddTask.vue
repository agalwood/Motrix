<template>
  <el-dialog
    custom-class="tab-title-dialog add-task-dialog"
    width="61.8vw"
    :visible.sync="visible"
    :before-close="handleClose"
    @open="handleOpen"
    @closed="handleClosed">
    <el-form
      ref="taskForm"
      label-position="left"
      :model="form"
      :rules="rules">
      <el-tabs :value="type" @tab-click="handleTabClick">
        <el-tab-pane :label="$t('task.uri-task')" name="uri">
          <el-form-item>
            <el-input
              ref="uri"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 5 }"
              auto-complete="off"
              :placeholder="$t('task.uri-task-tip')"
              @change="handleUriChange"
              v-model="form.uris">
            </el-input>
          </el-form-item>
        </el-tab-pane>
        <el-tab-pane
          :label="$t('task.torrent-task')"
          name="torrent"
          v-if="iLoveEggFeatures"
          >
          <el-form-item>
            <mo-select-torrent
              v-on:change="handleTorrentChange"
            />
          </el-form-item>
        </el-tab-pane>
      </el-tabs>
      <el-row :gutter="12">
        <el-col :span="15">
          <el-form-item :label="`${$t('task.task-out')}: `" :label-width="formLabelWidth">
            <el-input :placeholder="$t('task.task-out-tip')" v-model="form.out">
            </el-input>
          </el-form-item>
        </el-col>
        <el-col :span="9">
          <el-form-item :label="`${$t('task.task-split')}: `" :label-width="formLabelWidth">
            <el-input-number
              v-model="form.split"
              @change="handleSplitChange"
              controls-position="right"
              :min="1"
              :max="config.maxConnectionPerServer"
              :value="config.split"
              :label="$t('task.task-split')">
            </el-input-number>
          </el-form-item>
        </el-col>
      </el-row>
      <el-form-item :label="`${$t('task.task-dir')}: `" :label-width="formLabelWidth">
        <el-input placeholder="" v-model="downloadDir" :readonly="isMas()">
          <mo-select-directory
            v-if="isRenderer()"
            slot="append"
            @selected="onDirectorySelected"
          />
        </el-input>
      </el-form-item>
      <div v-if="showAdvanced">
        <el-form-item :label="`${$t('task.task-user-agent')}: `" :label-width="formLabelWidth">
          <el-input
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 3 }"
            auto-complete="off"
            :placeholder="$t('task.task-user-agent')"
            v-model="form.userAgent">
          </el-input>
        </el-form-item>
        <el-form-item :label="`${$t('task.task-referer')}: `" :label-width="formLabelWidth">
          <el-input
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 3 }"
            auto-complete="off"
            :placeholder="$t('task.task-referer')"
            v-model="form.referer">
          </el-input>
        </el-form-item>
        <el-form-item :label="`${$t('task.task-cookie')}: `" :label-width="formLabelWidth">
          <el-input
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 3 }"
            auto-complete="off"
            :placeholder="$t('task.task-cookie')"
            v-model="form.cookie">
          </el-input>
        </el-form-item>
        <el-form-item label="" :label-width="formLabelWidth">
          <el-checkbox class="chk" v-model="form.newTaskShowDownloading">{{$t('task.navigate-to-downloading')}}</el-checkbox>
        </el-form-item>
      </div>
    </el-form>
    <div slot="footer" class="dialog-footer">
      <el-checkbox class="chk" v-model="showAdvanced">{{$t('task.show-advanced-options')}}</el-checkbox>
      <el-button @click="handleCancel('taskForm')">{{$t('app.cancel')}}</el-button>
      <el-button type="primary" @click="submitForm('taskForm')">{{$t('app.submit')}}</el-button>
    </div>
  </el-dialog>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'
  import { isEmpty } from 'lodash'
  import SelectDirectory from '@/components/Native/SelectDirectory'
  import SelectTorrent from '@/components/Task/SelectTorrent'
  import { prettifyDir } from '@/components/Native/utils'
  import '@/components/Icons/inbox'
  import {
    detectResource,
    splitTaskLinks,
    needCheckCopyright
  } from '@shared/utils'

  const initialForm = (state) => {
    const { dir, split, newTaskShowDownloading } = state.preference.config
    const result = {
      uris: '',
      torrent: '',
      out: '',
      userAgent: '',
      referer: '',
      cookie: '',
      dir,
      split,
      newTaskShowDownloading
    }
    return result
  }

  export default {
    name: 'mo-add-task',
    components: {
      [SelectDirectory.name]: SelectDirectory,
      [SelectTorrent.name]: SelectTorrent
    },
    props: {
      visible: {
        type: Boolean,
        default: false
      },
      type: {
        type: String,
        default: 'uri'
      }
    },
    data () {
      return {
        formLabelWidth: '100px',
        showAdvanced: false,
        torrentName: '',
        form: {},
        rules: {}
      }
    },
    computed: {
      taskType: function () {
        return this.type
      },
      downloadDir: function () {
        return prettifyDir(this.form.dir)
      },
      ...mapState('app', {
        taskList: state => state.taskList
      }),
      ...mapState('preference', {
        config: state => state.config
      }),
      iLoveEggFeatures: function () {
        return !this.isMas() || (this.isMas() && this.config.enableEggFeatures)
      }
    },
    watch: {
      taskType: function (current, previous) {
        if (this.visible && previous === 'uri') {
          return
        }

        if (current === 'uri') {
          setTimeout(() => {
            this.$refs.uri && this.$refs.uri.focus()
          }, 50)
        }
      }
    },
    methods: {
      isRenderer: is.renderer,
      isMas: is.mas,
      handleOpen () {
        this.form = initialForm(this.$store.state)
        if (this.taskType === 'uri') {
          this.autofillResourceLink()
          setTimeout(() => {
            this.$refs.uri && this.$refs.uri.focus()
          }, 50)
        }
      },
      autofillResourceLink () {
        const content = this.$electron.clipboard.readText()
        const hasResource = detectResource(content)
        if (!hasResource) {
          return
        }
        this.form.uris = content
      },
      handleClose (done) {
        this.$store.dispatch('app/hideAddTaskDialog')
      },
      handleClosed () {
        this.reset()
      },
      handleTabClick (tab, event) {
        this.$store.dispatch('app/changeAddTaskType', tab.name)
      },
      handleUriChange () {
        // el-input does not support @paste event ?
        // https://github.com/ElemeFE/element/blob/master/packages/input/src/input.vue
        const { uris } = this.form
        if (uris.includes('thunder://')) {
          this.$msg({
            type: 'warning',
            message: this.$t('task.thunder-link-tip'),
            duration: 6000
          })
        }
      },
      handleTorrentChange (torrent, file, fileList) {
        // TODO 种子选择部分文件下载
        // console.log('handleTorrentChange===>', torrent, file, fileList)
        this.form.torrent = torrent
      },
      handleSplitChange (value) {
        console.log('handleSplitChange===>', value)
      },
      onDirectorySelected (dir) {
        this.form.dir = dir
      },
      reset () {
        this.form = initialForm(this.$store.state)
      },
      handleCancel (formName) {
        this.$store.dispatch('app/hideAddTaskDialog')
      },
      buildHeader (form) {
        const {
          userAgent, referer, cookie
        } = form
        const result = []

        if (!isEmpty(userAgent)) {
          result.push(`User-Agent: ${userAgent}`)
        }
        if (!isEmpty(referer)) {
          result.push(`Referer: ${referer}`)
        }
        if (!isEmpty(cookie)) {
          result.push(`Cookie: ${cookie}`)
        }
        return result
      },
      buildOption (form) {
        const {
          dir, out, split
        } = form
        const result = {}

        if (!isEmpty(dir)) {
          result.dir = dir
        }

        if (!isEmpty(out)) {
          result.out = out
        }

        if (split > 0) {
          result.split = split
        }

        const header = this.buildHeader(form)
        if (!isEmpty(header)) {
          result.header = header
        }
        return result
      },
      buildUriPayload (form) {
        let { uris } = form
        uris = splitTaskLinks(uris)
        const options = this.buildOption(form)
        const result = {
          uris,
          options
        }
        return result
      },
      buildTorrentPayload (form) {
        const { torrent } = form
        const options = this.buildOption(form)
        const result = {
          torrent,
          options
        }
        console.log('buildTorrentPayload===>', result)
        return result
      },
      addTask (type, form) {
        let payload = null
        if (type === 'uri') {
          payload = this.buildUriPayload(form)
          this.$store.dispatch('task/addUri', payload)
            .catch((err) => {
              this.$msg.error(err.message)
            })
        } else if (type === 'torrent') {
          payload = this.buildTorrentPayload(form)
          this.$store.dispatch('task/addTorrent', payload)
            .catch((err) => {
              this.$msg.error(err.message)
            })
        } else if (type === 'metalink') {
          // @TODO addMetalink
        } else {
          console.error('addTask fail', form)
        }
      },
      checkCopyright (type, form) {
        const { uris } = form

        return new Promise((resolve, reject) => {
          if (type !== 'uri') {
            resolve()
          }

          if (!needCheckCopyright(uris)) {
            resolve()
            return
          }

          if (this.iLoveEggFeatures) {
            resolve()
            return
          }

          this.$electron.remote.dialog.showMessageBox({
            type: 'warning',
            title: this.$t('task.copyright-warning'),
            message: this.$t('task.copyright-warning-message'),
            buttons: [this.$t('task.copyright-yes'), this.$t('task.copyright-no')],
            cancelId: 1
          }, (buttonIndex, checkboxChecked) => {
            if (buttonIndex === 0) {
              resolve()
            } else {
              reject(new Error(this.$t('task.copyright-error-message')))
            }
          })
        })
      },
      submitForm (formName) {
        this.$refs[formName].validate((valid) => {
          if (!valid) {
            return false
          }

          this.checkCopyright(this.type, this.form)
            .then(() => {
              this.addTask(this.type, this.form)
              this.$store.dispatch('app/hideAddTaskDialog')
              if (this.form.newTaskShowDownloading) {
                this.$router.push({
                  path: '/task/active'
                })
              }
            })
            .catch((err) => {
              this.$msg.error(err.message)
            })
        })
      }
    }
  }
</script>

<style lang="scss">
  .el-dialog.add-task-dialog {
    max-width: 632px;
    background-color: $--add-task-dialog-background;
    .el-tabs__header {
      user-select: none;
    }
    .el-input-number.el-input-number--mini {
      width: 100%;
    }
    .el-dialog__footer {
      padding-top: 20px;
      background-color: $--add-task-dialog-footer-background;
      border-radius: 0 0 5px 5px;
    }
    .dialog-footer {
      .chk {
        float: left;
        line-height: 28px;
      }
    }
  }
</style>
