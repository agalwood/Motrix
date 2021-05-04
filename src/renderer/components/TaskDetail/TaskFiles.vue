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
          min-width="250"
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
          width="90">
          <template slot-scope="scope">{{ scope.row.length | bytesToSize }}</template>
        </el-table-column>
        <el-table-column
          v-if="mode === 'detail'"
          :label="$t('task.file-completed-size')"
          align="right"
          width="90">
          <template slot-scope="scope">{{ scope.row.completedLength | bytesToSize }}</template>
        </el-table-column>
      </el-table>
    </div>
    <el-row :gutter="12" v-if="mode === 'add'">
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
    components: {
    },
    filters: {
      bytesToSize,
      removeExtensionDot
    },
    props: {
      mode: {
        type: String,
        default: 'add',
        validator: function (value) {
          return ['add', 'detail'].indexOf(value) !== -1
        }
      },
      height: {
        type: [Number, String],
        default: function () {
          return 200
        }
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
          return acc + cur.length
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
  button {
    font-size: 0;
  }
}
</style>
