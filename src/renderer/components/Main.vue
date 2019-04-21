<template>
  <el-container id="container">
    <mo-aside />
    <router-view></router-view>
    <mo-speedometer />
    <mo-add-task :visible="addTaskVisible" :type="addTaskType" />
    <mo-about-panel :visible="aboutPanelVisible" />
    <mo-task-item-info :visible="taskItemInfoVisible" :task="currentTaskItem" />
    <mo-dragger />
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
  import Dragger from '@/components/Dragger/Index'

  export default {
    name: 'mo-main',
    components: {
      [AboutPanel.name]: AboutPanel,
      [Aside.name]: Aside,
      [Subnav.name]: Subnav,
      [Speedometer.name]: Speedometer,
      [AddTask.name]: AddTask,
      [TaskItemInfo.name]: TaskItemInfo,
      [Dragger.name]: Dragger
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
    }
  }
</script>

<style lang="scss">
  .mo-speedometer {
    position: fixed;
    right: 36px;
    bottom: 24px;
  }
</style>
