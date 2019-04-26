<template>
  <el-container class="content panel" direction="horizontal">
    <el-aside width="200px" class="subnav">
      <router-view name="subnav" />
    </el-aside>
    <router-view name="form" />
  </el-container>
</template>

<script>
  export default {
    name: 'mo-content-preference',
    props: {
    },
    computed: {
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
    .el-form-item {
      a {
        color: $--color-text-regular;
        text-decoration: none;
        &:hover {
          color: $--color-text-primary;
          text-decoration: underline;
        }
        &:active {
          color: $--color-text-primary;
        }
      }
    }
    .el-form-item.el-form-item--mini {
      margin-bottom: 24px;
    }
    .el-form-item__content {
      color: $--color-text-regular;
    }
    .form-item-sub {
      margin-bottom: 12px;
      &:last-of-type {
        margin-bottom: 0;
      }
    }
  }
  .form-actions {
    position: fixed;
    bottom: 0;
    left: auto;
    z-index: 10;
    box-sizing: border-box;
    padding: 24px 36px 24px 0;
  }
</style>
