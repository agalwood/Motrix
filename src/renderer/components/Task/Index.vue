<template>
  <el-container
    class="content panel"
    direction="horizontal"
  >
    <el-aside
      width="200px"
      class="subnav hidden-xs-only"
    >
      <mo-task-subnav :current="status" />
    </el-aside>
    <el-container
      class="content panel"
      direction="vertical"
    >
      <el-header
        class="panel-header"
        height="84"
      >
        <h4 class="task-title hidden-xs-only">{{ title }}</h4>
        <mo-subnav-switcher
          :title="title"
          :subnavs="subnavs"
          class="hidden-sm-and-up"
        />
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
  import SubnavSwitcher from '@/components/Subnav/SubnavSwitcher'

  export default {
    name: 'mo-content-task',
    components: {
      [TaskSubnav.name]: TaskSubnav,
      [TaskActions.name]: TaskActions,
      [TaskList.name]: TaskList,
      [SubnavSwitcher.name]: SubnavSwitcher
    },
    props: {
      status: {
        type: String,
        default: 'active'
      }
    },
    computed: {
      subnavs: function () {
        return [
          {
            key: 'active',
            title: this.$t('task.active'),
            route: '/task/active'
          },
          {
            key: 'waiting',
            title: this.$t('task.waiting'),
            route: '/task/waiting'
          },
          {
            key: 'stopped',
            title: this.$t('task.stopped'),
            route: '/task/stopped'
          }
        ]
      },
      title: function () {
        const subnav = this.subnavs.find((item) => item.key === this.status)
        return subnav.title
      }
    },
    watch: {
      status: 'onStatusChange'
    },
    methods: {
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
