<template>
  <el-container class="content panel" direction="horizontal">
    <el-aside width="200px" class="subnav hidden-xs-only">
      <router-view name="subnav" />
    </el-aside>
    <router-view name="form" />
  </el-container>
</template>

<script>
  export default {
    name: 'mo-content-preference',
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
      font-weight: normal;
      color: $--color-text-regular;
      &.is-active {
        color: $--color-text-regular;
      }
    }
    .el-checkbox__input.is-checked + .el-checkbox__label {
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
      margin-bottom: 32px;
    }
    .el-form-item__content {
      color: $--color-text-regular;
    }
    .form-item-sub {
      margin-bottom: 8px;
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
    width: -webkit-fill-available;
    box-sizing: border-box;
    padding: 24px 36px;
    margin-left: -36px;
    // aside.width + subnav.width + padding-left + scrollbar.width
    margin-right: 322px;
  }
  .action-link {
    cursor: pointer;
    color: $--link-color;
    &:hover {
      color: $--link-hover-color;
      text-decoration: underline;
    }
  }
</style>
