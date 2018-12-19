<template>
  <el-container class="content panel" direction="horizontal">
    <el-aside width="200px" class="subnav">
      <mo-task-subnav :current="status" />
    </el-aside>
    <el-container class="content panel" direction="vertical">
      <el-header class="panel-header" height="84">
        <h4>{{ title }}</h4>
        <mo-task-actions />
      </el-header>
      <el-main class="panel-content">
        <mo-task-list />
      </el-main>
    </el-container>
  </el-container>
</template>

<script>
  import TaskSubnav from '@/components/Subnav/TaskSubnav'
  import TaskActions from '@/components/Task/TaskActions'
  import TaskList from '@/components/Task/TaskList'

  export default {
    name: 'mo-content-task',
    components: {
      [TaskSubnav.name]: TaskSubnav,
      [TaskActions.name]: TaskActions,
      [TaskList.name]: TaskList
    },
    props: {
      status: {
        type: String,
        default: 'active'
      }
    },
    computed: {
      title: function () {
        const titles = {
          'active': '下载中',
          'waiting': '已暂停',
          'stopped': '已完成'
        }
        return titles[this.status]
      }
    },
    watch: {
      'status': 'onStatusChange'
    },
    methods: {
      open (link) {
        this.$electron.shell.openExternal(link)
      },
      onStatusChange () {
        this.changeCurrentList()
      },
      changeCurrentList () {
        this.$store.dispatch('task/changeCurrentList', this.status)
      }
    },
    created: function () {
      this.changeCurrentList()
    }
  }
</script>

<style lang="scss">
</style>
