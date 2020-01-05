<template>
  <el-dropdown @command="handleCommand"
               class="task-switch"
               size="medium">
    <h4 class="task-title">
      {{ title }}<i class="el-icon-arrow-down el-icon--right"></i>
    </h4>
    <el-dropdown-menu slot="dropdown"
                      class="task-switch-dropdown">
      <el-dropdown-item :command="s.key"
                        v-for="s in commands"
                        :key="s.key">{{s.label}}</el-dropdown-item>
    </el-dropdown-menu>
  </el-dropdown>
</template>

<script>
export default {
  name: 'mo-task-switcher',
  props: {
    title: {
      type: String,
      default: function () {
        return this.$t('task.active')
      }
    },
    commands: {
      type: Array,
      default: function () {
        const s = ['active', 'waiting', 'stopped']
        return s.map(key => {
          return {
            key,
            label: this.$t(`task.${key}`)
          }
        })
      }
    }
  },
  methods: {
    calcIconName (key) {
      const statusIconMap = {
        active: 'start',
        waiting: 'pause',
        stopped: 'stop'
      }
      return `task-${statusIconMap[key]}` || ''
    },
    handleCommand (status) {
      this.$router.push({
        path: `/task/${status}`
      })
    }
  }
}
</script>

<style lang='scss'>
  .task-switch-dropdown {
    background: $--select-dropdown-background;
    & .el-dropdown-menu__item {
      font-size: 16px;
      color: $--select-option-color;
    }
  }
  .task-switch {
    & .task-title {
      color: $--task-action-color;
      font-size: 16px;
    }
  }
  .theme-dark {
    .task-switch-dropdown {
      background-color: $--dk-task-item-backgroud;
      border-color: $--dk-task-item-border-color;
      color: $--dk-task-item-text-color;
      & .el-dropdown-menu__item {
        color: $--dk-task-item-text-color;
        &.selected {
          color: $--color-primary;
        }
        &.hover,
        &:hover {
          background-color: $--color-primary;
          color: $--dk-titlebar-close-active-color;
        }
      }
    }
    & .el-dropdown {
      & .task-title {
        color: $--dk-task-action-color;
      }
    }
  }
</style>