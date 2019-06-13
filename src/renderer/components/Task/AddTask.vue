<template>
  <el-dialog
    custom-class="tab-title-dialog add-task-dialog"
    width="61.8vw"
    :visible.sync="visible"
    :before-close="handleClose"
    @open="handleOpen"
    @opened="handleOpened"
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
              :placeholder="$t('task.uri-task-tips')"
              @change="handleUriChange"
              @paste.native="handleUriPaste"
              v-model="form.uris">
            </el-input>
          </el-form-item>
        </el-tab-pane>
        <el-tab-pane
          :label="$t('task.torrent-task')"
          name="torrent"
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
            <el-input :placeholder="$t('task.task-out-tips')" v-model="form.out">
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
  import {
    NONE_SELECTED_FILES,
    SELECTED_ALL_FILES
  } from '@shared/constants'
  import {
    detectResource,
    splitTaskLinks
  } from '@shared/utils'
  import '@/components/Icons/inbox'

  const initialForm = (state) => {
    const { addTaskUrl } = state.app
    const { dir, split, newTaskShowDownloading } = state.preference.config
    const result = {
      uris: addTaskUrl,
      torrent: '',
      selectFile: NONE_SELECTED_FILES,
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
      })
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
        if (isEmpty(this.form.uris)) {
          this.form.uris = content
        }
      },
      handleOpened () {
        this.detectThunderResource(this.form.uris)
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
      handleUriPaste () {
        setImmediate(() => {
          const uris = this.$refs.uri.value
          this.detectThunderResource(uris)
        })
      },
      detectThunderResource (uris = '') {
        if (uris.includes('thunder://')) {
          this.$msg({
            type: 'warning',
            message: this.$t('task.thunder-link-tips'),
            duration: 6000
          })
        }
      },
      handleUriChange () {
        console.log('handleUriChange===>', this.form.uris)
      },
      handleTorrentChange (torrent, selectedFileIndex) {
        this.form.torrent = torrent
        this.form.selectFile = selectedFileIndex
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
      buildOption (type, form) {
        const {
          dir,
          out,
          selectFile,
          split
        } = form
        const result = {}

        if (!isEmpty(dir)) {
          result.dir = dir
        }

        if (!isEmpty(out)) {
          result.out = out
        }

        if (type === 'torrent') {
          if (
            selectFile !== SELECTED_ALL_FILES &&
            selectFile !== NONE_SELECTED_FILES
          ) {
            result.selectFile = selectFile
          }
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
        if (isEmpty(uris)) {
          throw new Error(this.$t('task.new-task-uris-required'))
        }
        uris = splitTaskLinks(uris)
        const options = this.buildOption('uri', form)
        const result = {
          uris,
          options
        }
        return result
      },
      buildTorrentPayload (form) {
        const { torrent } = form
        if (isEmpty(torrent)) {
          throw new Error(this.$t('task.new-task-torrent-required'))
        }
        const options = this.buildOption('torrent', form)
        const result = {
          torrent,
          options
        }
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
      submitForm (formName) {
        this.$refs[formName].validate((valid) => {
          if (!valid) {
            return false
          }

          try {
            this.addTask(this.type, this.form)
            this.$store.dispatch('app/hideAddTaskDialog')
            if (this.form.newTaskShowDownloading) {
              this.$router.push({
                path: '/task/active'
              })
            }
          } catch (err) {
            this.$msg.error(err.message)
          }
        })
      }
    }
  }
</script>

<style lang="scss">
  .el-dialog.add-task-dialog {
    max-width: 632px;
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
