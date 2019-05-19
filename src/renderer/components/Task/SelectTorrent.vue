<template>
  <el-upload
    class="upload-torrent"
    drag
    action="/"
    v-if="isTorrentsEmpty"
    :limit="1"
    :multiple="false"
    accept=".torrent"
    :on-change="handleChange"
    :on-exceed="handleExceed"
    :auto-upload="false"
    :show-file-list="false">
    <i class="upload-inbox-icon"><mo-icon name="inbox" width="24" height="24" /></i>
    <div class="el-upload__text">
      {{ $t('task.select-torrent') }}
      <div class="torrent-name" v-if="name">{{ name }}</div>
    </div>
  </el-upload>
  <div
    class="selective-torrent"
    v-else
  >
    <el-row class="torrent-info" :gutter="12">
      <el-col class="torrent-name" :span="20">
        <el-tooltip class="item" effect="dark" :content="name" placement="top">
          <span>{{ name }}</span>
        </el-tooltip>
      </el-col>
      <el-col class="torrent-actions" :span="4">
        <span
          @click="handleTrashClick"
        >
          <mo-icon name="trash" width="14" height="14" />
        </span>
      </el-col>
    </el-row>
    <div class="torrent-file-list">
      <el-table
        stripe
        ref="torrentTable"
        height="200"
        :data="files"
        tooltip-effect="dark"
        style="width: 100%"
        @row-dblclick="handleRowDbClick"
        @selection-change="handleSelectionChange">
        <el-table-column
          type="selection"
          width="35">
        </el-table-column>
        <el-table-column
          :label="$t('task.file-name')"
          show-overflow-tooltip>
          <template slot-scope="scope">{{ scope.row.name }}</template>
        </el-table-column>
        <el-table-column
          :label="$t('task.file-extension')"
          width="80">
          <template slot-scope="scope">{{ scope.row.extension | removeExtensionDot }}</template>
        </el-table-column>
        <el-table-column
          :label="$t('task.file-size')"
          width="90">
          <template slot-scope="scope">{{ scope.row.length | bytesToSize }}</template>
        </el-table-column>
      </el-table>
    </div>
    <el-row :gutter="12">
      <el-col class="file-filters" :span="8">
        <el-button-group>
          <el-button @click="toggleVideoSelection()">
            <mo-icon name="video" width="12" height="12" />
          </el-button>
          <el-button @click="toggleAudioSelection()">
            <mo-icon name="audio" width="12" height="12" />
          </el-button>
          <el-button @click="toggleImageSelection()">
            <mo-icon name="image" width="12" height="12" />
          </el-button>
        </el-button-group>
      </el-col>
      <el-col :span="16" style="text-align: right">
        {{ $t('task.selected-files-sum', { selectedFilesCount, selectedFilesTotalSize }) }}
      </el-col>
    </el-row>
  </div>
</template>

<script>
  import { mapState } from 'vuex'
  import { isEmpty } from 'lodash'
  import parseTorrent from 'parse-torrent'
  import '@/components/Icons/inbox'
  import '@/components/Icons/video'
  import '@/components/Icons/audio'
  import '@/components/Icons/image'
  import {
    NONE_SELECTED_FILES,
    SELECTED_ALL_FILES
  } from '@shared/constants'
  import {
    buildFileList,
    listTorrentFiles,
    bytesToSize,
    filterVideoFiles,
    filterAudioFiles,
    filterImageFiles,
    getAsBase64,
    removeExtensionDot
  } from '@shared/utils'

  export default {
    name: 'mo-select-torrent',
    components: {
    },
    filters: {
      bytesToSize,
      removeExtensionDot
    },
    props: {
    },
    data () {
      return {
        name: '',
        currentTorrent: '',
        files: [],
        selectedFiles: []
      }
    },
    computed: {
      ...mapState('preference', {
        config: state => state.config
      }),
      ...mapState('app', {
        torrents: state => state.addTaskTorrents
      }),
      isTorrentsEmpty: function () {
        return this.torrents.length === 0
      },
      selectedFilesCount: function () {
        return this.selectedFiles.length
      },
      selectedFilesTotalSize: function () {
        const result = this.selectedFiles.reduce((acc, cur) => {
          return acc + cur.length
        }, 0)
        return bytesToSize(result)
      },
      selectedFileIndex: function () {
        const { files, selectedFiles } = this
        if (files.length === 0 || selectedFiles.length === 0) {
          return NONE_SELECTED_FILES
        }
        if (files.length === selectedFiles.length) {
          return SELECTED_ALL_FILES
        }
        const indexArr = this.selectedFiles.map((item) => item.idx)
        const result = indexArr.join(',')
        return result
      }
    },
    watch: {
      torrents (fileList) {
        if (fileList.length === 0) {
          this.reset()
          return
        }

        const file = fileList[0]
        if (!file.raw) {
          return
        }

        parseTorrent.remote(file.raw, (err, parsedTorrent) => {
          if (err) throw err
          console.log(parsedTorrent)
          this.files = listTorrentFiles(parsedTorrent.files)
          this.$refs.torrentTable.toggleAllSelection()

          getAsBase64(file.raw, (torrent) => {
            this.name = file.name
            this.currentTorrent = torrent
            this.$emit('change', torrent, SELECTED_ALL_FILES)
          })
        })
      },
      selectedFileIndex () {
        const { currentTorrent, selectedFileIndex } = this
        this.$emit('change', currentTorrent, selectedFileIndex)
      }
    },
    methods: {
      reset () {
        this.name = ''
        this.currentTorrent = ''
        this.files = []
        this.$refs.torrentTable.clearSelection()
        this.$emit('change', '', NONE_SELECTED_FILES)
      },
      handleChange (file, fileList) {
        this.$store.dispatch('app/addTaskAddTorrents', { fileList })
      },
      handleExceed (files) {
        const fileList = buildFileList(files[0])
        this.$store.dispatch('app/addTaskAddTorrents', { fileList })
      },
      handleTrashClick () {
        this.$store.dispatch('app/addTaskAddTorrents', { fileList: [] })
      },
      toggleSelection (rows) {
        if (isEmpty(rows)) {
          this.$refs.torrentTable.clearSelection()
        } else {
          this.$refs.torrentTable.clearSelection()
          rows.forEach(row => {
            this.$refs.torrentTable.toggleRowSelection(row)
          })
        }
      },
      toggleVideoSelection () {
        const filtered = filterVideoFiles(this.files)
        this.toggleSelection(filtered)
      },
      toggleAudioSelection () {
        const filtered = filterAudioFiles(this.files)
        this.toggleSelection(filtered)
      },
      toggleImageSelection () {
        const filtered = filterImageFiles(this.files)
        this.toggleSelection(filtered)
      },
      handleRowDbClick (row, column, event) {
        this.$refs.torrentTable.toggleRowSelection(row)
      },
      handleSelectionChange (val) {
        this.selectedFiles = val
      }
    }
  }
</script>

<style lang="scss">
  .upload-torrent {
    width: 100%;
    .el-upload, .el-upload-dragger {
      width: 100%;
    }
    .el-upload-dragger {
      border-radius: 4px;
      padding: 24px;
      height: auto;
    }
    .upload-inbox-icon {
      display: inline-block;
      margin-bottom: 12px;
    }
    .torrent-name {
      margin-top: 4px;
      font-size: $--font-size-small;
      color: $--color-text-secondary;
      line-height: 16px;
    }
  }
  .selective-torrent {
    .torrent-name {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .torrent-info {
      margin-bottom: 15px;
      font-size: 12px;
      line-height: 16px;
    }
    .torrent-actions {
      text-align: right;
      line-height: 16px;
      &> span {
        cursor: pointer;
        display: inline-block;
        vertical-align: middle;
        height: 14px;
        padding: 1px;
      }
    }
  }
  .file-filters {
    button {
      font-size: 0;
    }
  }
  .torrent-file-list {
    border: 1px solid #ebeef5;
    border-bottom: none;
    overflow-x: hidden;
    overflow-y: scroll;
    margin-bottom: 8px;
    .el-table th {
      padding: 2px 0;
    }
  }
</style>
