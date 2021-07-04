<template>
  <el-container id="container">
    <mo-aside />
    <router-view />
    <mo-speedometer />
    <mo-add-task :visible="addTaskVisible" :type="addTaskType" />
    <mo-about-panel :visible="aboutPanelVisible" />
    <mo-task-detail
      :visible="taskDetailVisible"
      :gid="currentTaskGid"
      :task="currentTaskItem"
      :files="currentTaskFiles"
      :peers="currentTaskPeers"
    />
    <mo-dragger />
  </el-container>
</template>

<script>
  import { mapState } from 'vuex'
  import AboutPanel from '@/components/About/AboutPanel'
  import Aside from '@/components/Aside/Index'
  import Speedometer from '@/components/Speedometer/Speedometer'
  import AddTask from '@/components/Task/AddTask'
  import TaskDetail from '@/components/TaskDetail/Index'
  import Dragger from '@/components/Dragger/Index'

  export default {
    name: 'mo-main',
    components: {
      [AboutPanel.name]: AboutPanel,
      [Aside.name]: Aside,
      [Speedometer.name]: Speedometer,
      [AddTask.name]: AddTask,
      [TaskDetail.name]: TaskDetail,
      [Dragger.name]: Dragger
    },
    computed: {
      ...mapState('app', {
        aboutPanelVisible: state => state.aboutPanelVisible,
        addTaskVisible: state => state.addTaskVisible,
        addTaskType: state => state.addTaskType
      }),
      ...mapState('task', {
        taskDetailVisible: state => state.taskDetailVisible,
        currentTaskGid: state => state.currentTaskGid,
        currentTaskItem: state => state.currentTaskItem,
        currentTaskFiles: state => state.currentTaskFiles,
        currentTaskPeers: state => state.currentTaskPeers
      })
    },
    methods: {
    }
  }
</script>

<style lang="scss">
  .mo-speedometer {
    position: fixed;
    right: 16px;
    bottom: 24px;
    z-index: 20;
  }
</style>
