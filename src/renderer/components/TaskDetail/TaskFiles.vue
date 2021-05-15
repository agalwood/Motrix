<template>
  <div class="mo-task-files" v-if="files">
    <div class="mo-table-wrapper">
      <el-table
        stripe
        ref="torrentTable"
        :height="height"
        :data="files"
        tooltip-effect="dark"
        style="width: 100%"
        @row-dblclick="handleRowDbClick"
        @selection-change="handleSelectionChange">
        <el-table-column
          type="selection"
          width="42">
        </el-table-column>
        <el-table-column
          :label="$t('task.file-name')"
          min-width="200"
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
          align="right"
          width="85">
          <template slot-scope="scope">{{ scope.row.length | bytesToSize }}</template>
        </el-table-column>
        <el-table-column
          v-if="mode === 'DETAIL'"
          :label="$t('task.file-completed-size')"
          align="right"
          width="95">
          <template slot-scope="scope">{{ scope.row.completedLength | bytesToSize }}</template>
        </el-table-column>
      </el-table>
    </div>
    <el-row class="file-filters" :gutter="12">
      <el-col class="quick-filters" :span="8">
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
      <el-col :span="16" class="files-summary">
        {{ $t('task.selected-files-sum', { selectedFilesCount, selectedFilesTotalSize }) }}
      </el-col>
    </el-row>
  </div>
</template>

<script>
  import { isEmpty } from 'lodash'
  import '@/components/Icons/video'
  import '@/components/Icons/audio'
  import '@/components/Icons/image'
  import {
    NONE_SELECTED_FILES,
    SELECTED_ALL_FILES
  } from '@shared/constants'
  import {
    bytesToSize,
    filterVideoFiles,
    filterAudioFiles,
    filterImageFiles,
    removeExtensionDot
  } from '@shared/utils'

  export default {
    name: 'mo-task-files',
    filters: {
      bytesToSize,
      removeExtensionDot
    },
    props: {
      mode: {
        type: String,
        default: 'ADD',
        validator: function (value) {
          return ['ADD', 'DETAIL'].indexOf(value) !== -1
        }
      },
      height: {
        type: [Number, String]
      },
      files: {
        type: Array,
        default: function () {
          return []
        }
      }
    },
    data () {
      return {
        selectedFiles: []
      }
    },
    computed: {
      selectedFilesCount () {
        return this.selectedFiles.length
      },
      selectedFilesTotalSize () {
        const result = this.selectedFiles.reduce((acc, cur) => {
          return acc + parseInt(cur.length, 10)
        }, 0)
        return bytesToSize(result)
      },
      selectedFileIndex () {
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
      selectedFileIndex () {
        const { selectedFileIndex } = this
        this.$emit('selection-change', selectedFileIndex)
      }
    },
    methods: {
      toggleAllSelection () {
        if (!this.$refs.torrentTable) {
          return
        }
        this.$refs.torrentTable.toggleAllSelection()
      },
      clearSelection () {
        if (!this.$refs.torrentTable) {
          return
        }
        this.$refs.torrentTable.clearSelection()
      },
      toggleSelection (rows) {
        if (isEmpty(rows)) {
          this.$refs.torrentTable.clearSelection()
        } else {
          this.$refs.torrentTable.clearSelection()
          rows.forEach(row => {
            this.$refs.torrentTable.toggleRowSelection(row, true)
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
.file-filters {
  margin-top: 0.5rem;
  .quick-filters {
    button {
      font-size: 0;
    }
  }
  .files-summary {
    text-align: right;
    font-size: $--font-size-base;
    color: $--color-text-regular;
    line-height: 1.75rem;
  }
}
</style>
