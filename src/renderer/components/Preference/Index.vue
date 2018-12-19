<template>
  <el-container class="content panel" direction="horizontal">
    <el-aside width="200px" class="subnav">
      <router-view name="subnav"></router-view>
    </el-aside>
    <router-view name="form"></router-view>
  </el-container>
</template>

<script>
  export default {
    name: 'mo-content-preference',
    props: {
      category: {
        type: String
      }
    },
    computed: {
      title: function () {
        const titles = {
          'basic': '基础设置',
          'advanced': '进阶设置',
          'lab': '实验室'
        }
        return titles[this.category]
      }
    },
    components: {
    },
    methods: {
    }
  }
</script>

<style lang="scss">
  .form-preference {
    padding-right: 7%;
    .el-switch__label {
      font-weight: $--font-weight-secondary;
      color: $--color-text-regular;
    }
    .el-form-item.el-form-item--mini {
      margin-bottom: 24px;
    }
    .el-form-item__content {
      color: $--color-text-regular;
    }
    .form-item-sub {
      margin-bottom: 12px;
      a {
        color: $--color-text-regular;
        text-decoration: none;
        &:hover {
          color: $--color-text-primary;
          text-decoration: underline;
        }
      }
    }
  }
  .form-actions {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 100%;
    box-sizing: border-box;
    padding: 24px 36px;
  }
</style>
