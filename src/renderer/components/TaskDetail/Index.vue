<template>
  <el-drawer
    custom-class="panel task-detail-drawer"
    size="61.8%"
    v-if="gid"
    :title="$t('task.task-detail-title')"
    :with-header="true"
    :show-close="true"
    :visible.sync="visible"
    :before-close="handleClose"
    @closed="handleClosed"
  >
    <el-tabs
      tab-position="top"
      class="task-detail-tab"
      value="general"
      :before-leave="handleTabBeforeLeave"
      @tab-click="handleTabClick"
    >
      <el-tab-pane name="general">
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-info"></i></span>
        <mo-task-general :task="task" />
      </el-tab-pane>
      <el-tab-pane name="activity" lazy>
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-s-grid"></i></span>
        <mo-task-activity ref="taskGraphic" :task="task" />
      </el-tab-pane>
      <el-tab-pane name="trackers" lazy v-if="isBT">
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-discover"></i></span>
        <mo-task-trackers :task="task" />
      </el-tab-pane>
      <el-tab-pane name="peers" lazy v-if="isBT">
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-s-custom"></i></span>
        <mo-task-peers :peers="peers" />
      </el-tab-pane>
      <el-tab-pane name="files" lazy>
        <span class="task-detail-tab-label" slot="label"><i class="el-icon-files"></i></span>
        <mo-task-files
          ref="detailFileList"
          mode="DETAIL"
          :files="fileList"
          @selection-change="handleSelectionChange"
        />
      </el-tab-pane>
    </el-tabs>
    <div class="task-detail-actions">
      <mo-task-item-actions mode="DETAIL" :task="task" />
    </div>
  </el-drawer>
</template>

<script>
  import is from 'electron-is'
  import { debounce, merge } from 'lodash'
  import {
    calcFormLabelWidth,
    checkTaskIsBT,
    checkTaskIsSeeder,
    getFileName,
    getFileExtension
  } from '@shared/utils'
  import { EMPTY_STRING, TASK_STATUS } from '@shared/constants'
  import TaskItemActions from '@/components/Task/TaskItemActions'
  import TaskGeneral from './TaskGeneral'
  import TaskActivity from './TaskActivity'
  import TaskTrackers from './TaskTrackers'
  import TaskPeers from './TaskPeers'
  import TaskFiles from './TaskFiles'

  const cached = {
    files: []
  }

  export default {
    name: 'mo-task-detail',
    components: {
      [TaskItemActions.name]: TaskItemActions,
      [TaskGeneral.name]: TaskGeneral,
      [TaskActivity.name]: TaskActivity,
      [TaskTrackers.name]: TaskTrackers,
      [TaskPeers.name]: TaskPeers,
      [TaskFiles.name]: TaskFiles
    },
    props: {
      gid: {
        type: String
      },
      task: {
        type: Object
      },
      files: {
        type: Array,
        default: function () {
          return []
        }
      },
      peers: {
        type: Array,
        default: function () {
          return []
        }
      },
      visible: {
        type: Boolean,
        default: false
      }
    },
    data () {
      const { locale } = this.$store.state.preference.config
      return {
        form: {},
        formLabelWidth: calcFormLabelWidth(locale),
        locale,
        activeTab: 'general',
        graphicWidth: 0
      }
    },
    computed: {
      isRenderer: () => is.renderer(),
      isBT () {
        return checkTaskIsBT(this.task)
      },
      isSeeder () {
        return checkTaskIsSeeder(this.task)
      },
      taskStatus () {
        const { task, isSeeder } = this
        if (isSeeder) {
          return TASK_STATUS.SEEDING
        } else {
          return task.status
        }
      },
      fileList () {
        const { files } = this
        const result = files.map((item) => {
          const name = getFileName(item.path)
          const extension = getFileExtension(name)
          return {
            idx: Number(item.index),
            selected: item.selected === 'true',
            path: item.path,
            name,
            extension,
            length: item.length,
            completedLength: item.completedLength
          }
        })
        merge(cached.files, result)

        return cached.files
      },
      selectedFileList () {
        const { fileList } = this
        const result = fileList.filter((item) => item.selected)

        return result
      }
    },
    mounted () {
      window.addEventListener('resize', debounce(() => {
        console.log('resize===>', this.activeTab, this.$refs.taskGraphic)
        if (this.activeTab === 'activity' && this.$refs.taskGraphic) {
          this.$refs.taskGraphic.updateGraphicWidth()
        }
      }, 300))
    },
    destroyed () {
      cached.files = []
      window.removeEventListener('resize')
    },
    methods: {
      handleClose (done) {
        this.$store.dispatch('task/hideTaskDetail')
      },
      handleClosed (done) {
        this.$store.dispatch('task/updateCurrentTaskGid', EMPTY_STRING)
        this.$store.dispatch('task/updateCurrentTaskItem', null)
      },
      handleTabBeforeLeave (activeName, oldActiveName) {
        this.activeTab = activeName
        if (oldActiveName !== 'peers') {
          return
        }
        this.$store.dispatch('task/toggleEnabledFetchPeers', false)
      },
      handleTabClick (tab) {
        const { name } = tab

        switch (name) {
        case 'peers':
          this.$store.dispatch('task/toggleEnabledFetchPeers', true)
          break
        case 'files':
          setImmediate(() => {
            this.updateFilesListSelection()
          })
          break
        }
      },
      updateFilesListSelection () {
        if (!this.$refs.detailFileList) {
          return
        }

        const { selectedFileList } = this
        this.$refs.detailFileList.toggleSelection(selectedFileList)
      },
      handleSelectionChange (val) {
        console.log('task detail handleSelectionChange==>', val)
      }
    }
  }
</script>

<style lang="scss">
.task-detail-drawer {
  .el-drawer__header {
    margin-bottom: 0;
  }
  .el-drawer__body {
    position: relative;
  }
  .task-detail-actions {
    position: sticky;
    left: 0;
    bottom: 1rem;
    z-index: inherit;
    width: 100%;
    text-align: center;
    font-size: 0;
    .task-item-actions {
      display: inline-block;
      &> .task-item-action {
        margin: 0 0.5rem;
      }
    }
  }
  .task-detail-drawer-title {
    &> span, &> ul {
      vertical-align: middle;
    }
  }
}

.task-detail-tab {
  height: 100%;
  padding: 0.5rem 1.25rem 3.125rem;
  display: flex;
  flex-direction: column;
  .task-detail-tab-label {
    padding: 0 0.75rem;
  }
  .el-tabs__content {
    position: relative;
    height: 100%;
  }
  .el-tab-pane {
    overflow-x: hidden;
    overflow-y: auto;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }
}
</style>
