<template>
  <el-container class="content panel"
                direction="horizontal">
    <el-aside width="200px"
              class="subnav hidden-xs-only">
      <mo-task-subnav :current="status" />
    </el-aside>
    <el-container class="content panel"
                  direction="vertical">
      <el-header class="panel-header"
                 height="84">
        <h4 class="task-title hidden-xs-only">{{ title }}</h4>
        <mo-task-switcher :title="title"
                          :commands="titles"
                          class="hidden-sm-and-up" />
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
import TaskSwitch from '@/components/Task/TaskSwitcher'

export default {
  name: 'mo-content-task',
  components: {
    [TaskSubnav.name]: TaskSubnav,
    [TaskActions.name]: TaskActions,
    [TaskList.name]: TaskList,
    [TaskSwitch.name]: TaskSwitch
  },
  props: {
    status: {
      type: String,
      default: 'active'
    }
  },
  computed: {
    titleMap: function () {
      return {
        active: this.$t('task.active'),
        waiting: this.$t('task.waiting'),
        stopped: this.$t('task.stopped')
      }
    },
    titles: function () {
      return Object.keys(this.titleMap).map(key => {
        return {
          key,
          label: this.titleMap[key]
        }
      })
    },
    title: function () {
      return this.titleMap[this.status]
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
