<template>
  <div class="task-actions">
    <el-tooltip class="item" effect="dark" content="刷新列表" placement="bottom">
      <i @click="onRefreshClick">
        <mo-icon name="refresh" width="14" height="14" :spin="refreshing" />
      </i>
    </el-tooltip>
    <el-tooltip class="item" effect="dark" content="恢复所有任务" placement="bottom">
      <i @click="onResumeAllClick">
        <mo-icon name="task-start-line" width="14" height="14" />
      </i>
    </el-tooltip>
    <el-tooltip class="item" effect="dark" content="暂停所有任务" placement="bottom">
      <i @click="onPauseAllClick">
        <mo-icon name="task-pause-line" width="14" height="14" />
      </i>
    </el-tooltip>
    <!-- <el-tooltip class="item" effect="dark" content="移除选中的任务" placement="bottom">
      <i>
        <mo-icon name="delete" width="14" height="14" />
      </i>
    </el-tooltip> -->
    <el-tooltip
      class="item"
      effect="dark"
      content="清除已完成的任务"
      placement="bottom"
      v-if="currentList === 'stopped'"
    >
      <i @click="onPurgeRecordClick">
        <mo-icon name="purge" width="14" height="14" />
      </i>
    </el-tooltip>
  </div>
</template>

<script>
  import { mapState } from 'vuex'
  import TaskProgress from './TaskProgress'
  import '@/components/Icons/refresh'
  import '@/components/Icons/task-start-line'
  import '@/components/Icons/task-pause-line'
  import '@/components/Icons/delete'
  import '@/components/Icons/purge'
  import '@/components/Icons/more'
  import {
    getTaskName,
    bytesToSize,
    timeFormat
  } from '@shared/utils'

  export default {
    name: 'mo-task-actions',
    components: {
      [TaskProgress.name]: TaskProgress
    },
    props: ['task'],
    data: function () {
      return {
        refreshing: false
      }
    },
    computed: {
      ...mapState('task', {
        currentList: state => state.currentList
      })
    },
    filters: {
      bytesToSize,
      timeFormat
    },
    methods: {
      getTaskName,
      refreshSpin: function () {
        this.t && clearTimeout(this.t)

        this.refreshing = true
        this.t = setTimeout(() => {
          this.refreshing = false
        }, 500)
      },
      onRefreshClick: function () {
        this.refreshSpin()
        this.$store.dispatch('task/fetchList')
      },
      onResumeAllClick: function () {
        this.$store.dispatch('task/resumeAllTask')
          .then(() => {
            this.$message.success(`恢复全部任务成功`)
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$message.error(`恢复全部任务失败`)
            }
          })
      },
      onPauseAllClick: function () {
        this.$store.dispatch('task/pauseAllTask')
          .then(() => {
            this.$message.success(`暂停全部任务成功`)
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$message.error(`暂停全部任务失败`)
            }
          })
      },
      onPurgeRecordClick: function () {
        this.$store.dispatch('task/purgeTaskRecord')
          .then(() => {
            this.$message.success(`移除全部下载记录成功`)
          })
          .catch(({ code }) => {
            if (code === 1) {
              this.$message.error(`移除全部下载记录失败`)
            }
          })
      }
    }
  }
</script>

<style lang="scss">
  @import '../Theme/Variables';
  @import '../Theme/Darkness/Variables';

  .task-actions {
    position: absolute;
    top: 44px;
    right: 0;
    height: 24px;
    padding: 0;
    overflow: hidden;
    user-select: none;
    cursor: default;
    text-align: right;
    color: #4D515A;
    transition: all 0.25s;
    &> i {
      display: inline-block;
      padding: 5px;
      margin: 0 4px;
      font-size: 0;
      cursor: pointer;
      outline: none;
      &:hover {
        color: $--color-primary;
      }
    }
  }
</style>
