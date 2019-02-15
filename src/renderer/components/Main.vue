<template>
  <el-container id="container">
    <mo-aside />
    <router-view></router-view>
    <mo-speedometer />
    <mo-add-task :visible="addTaskVisible" :type="addTaskType" />
    <mo-about-panel :visible="aboutPanelVisible" />
    <mo-task-item-info :visible="taskItemInfoVisible" :task="currentTaskItem" />
  </el-container>
</template>

<script>
  import { mapState } from 'vuex'
  import AboutPanel from '@/components/About/AboutPanel'
  import Aside from '@/components/Aside/Index'
  import Subnav from '@/components/Subnav/Index'
  import Speedometer from '@/components/Speedometer/Speedometer'
  import AddTask from '@/components/Task/AddTask'
  import TaskItemInfo from '@/components/Task/TaskItemInfo'

  export default {
    name: 'mo-main',
    components: {
      [AboutPanel.name]: AboutPanel,
      [Aside.name]: Aside,
      [Subnav.name]: Subnav,
      [Speedometer.name]: Speedometer,
      [AddTask.name]: AddTask,
      [TaskItemInfo.name]: TaskItemInfo
    },
    computed: {
      ...mapState('app', {
        aboutPanelVisible: state => state.aboutPanelVisible,
        addTaskVisible: state => state.addTaskVisible,
        addTaskType: state => state.addTaskType
      }),
      ...mapState('task', {
        taskItemInfoVisible: state => state.taskItemInfoVisible,
        currentTaskItem: state => state.currentTaskItem
      })
    },
    methods: {
    },
    created () {
      document.ondragover = document.ondrop = (ev) => {
        ev.preventDefault()
      }

      document.body.ondrop = (ev) => {
        ev.preventDefault()

        const fileList = [...ev.dataTransfer.files]
          .map(item => ({ raw: item, name: item.name }))
          .filter(item => /\.torrent$/.test(item.name))
        if (!fileList.length) {
          return
        }

        this.$store.dispatch('app/showAddTaskDialog', 'torrent')

        this.$nextTick(() => {
          this.$store.dispatch('app/addTaskAddTorrents', { fileList })
        })
      }
    }
  }
</script>

<style lang="scss">
  .mo-speedometer {
    position: fixed;
    right: 36px;
    bottom: 24px;
  }
  .panel {
    background: $--panel-background;
    .panel-header {
      position: relative;
      padding: 44px 0 12px;
      margin: 0 36px;
      border-bottom: 2px solid $--panel-border-color;
      h4 {
        margin: 0;
        color: $--panel-title-color;
        font-size: 16px;
        font-weight: normal;
        line-height: 24px;
      }
    }
    .panel-content {
      position: relative;
      padding: 16px 36px 24px;
      height: 100%;
    }
  }
</style>
