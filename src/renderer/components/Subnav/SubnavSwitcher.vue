<template>
  <el-dropdown @command="handleRoute" class="subnav-switch" size="medium">
    <h4 class="subnav-title">
      {{ title }}
      <i class="el-icon-arrow-down el-icon--right" />
    </h4>
    <el-dropdown-menu slot="dropdown" class="subnav-switch-dropdown">
      <el-dropdown-item :command="sn.route" v-for="sn in subnavs" :key="sn.key">
        {{ sn.title }}
      </el-dropdown-item>
    </el-dropdown-menu>
  </el-dropdown>
</template>

<script>
export default {
  name: 'mo-subnav-switcher',
  props: {
    title: {
      type: String
    },
    subnavs: {
      type: Array
    }
  },
  methods: {
    handleRoute (route) {
      this.$router.push({
        path: route
      }).catch(err => {
        console.log(err)
      })
    }
  }
}
</script>

<style lang='scss'>
.subnav-switch-dropdown {
  background: $--select-dropdown-background;
  & .el-dropdown-menu__item {
    font-size: 16px;
    color: $--select-option-color;
  }
}
.subnav-switch {
  & .subnav-title {
    color: $--subnav-action-color;
    font-size: 16px;
  }
}
.theme-dark {
  .subnav-switch-dropdown {
    background-color: $--dk-subnav-background;
    border-color: $--dk-subnav-border-color;
    color: $--dk-subnav-text-color;
    & .el-dropdown-menu__item {
      color: $--dk-subnav-text-color;
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
    & .subnav-title {
      color: $--dk-subnav-action-color;
    }
  }
}
</style>
