<template>
  <el-aside width="200px" class="subnav">
    <router-view name="subnav"></router-view>
  </el-aside>
</template>

<script>
  // import { mapState, mapGetters } from 'vuex'

  export default {
    name: 'mo-subnav',
    components: {
    },
    computed: {
      // ...mapState('app', {
      //   currentPage: state => state.currentPage
      // }),
      // ...mapGetters('app', {
      //   title: 'currentPageTitle'
      // })
    },
    methods: {
    }
  }
</script>

<style lang="scss">
  .subnav-inner {
    margin-top: 44px;
    padding: 0 16px;
    h3 {
      font-size: 16px;
      color: #071D43;
      font-weight: normal;
      line-height: 24px;
      margin: 0 0 28px;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
      user-select: none;
      cursor: default;
      li {
        margin-bottom: 8px;
        padding: 8px 10px;
        font-size: 14px;
        line-height: 20px;
        border-radius: 3px;
        cursor: pointer;
        i, span {
          vertical-align: middle;
          display: inline-block;
        }
        &:hover, &.active {
          background-color: #EAECF0;
          i, span, svg {
            color: $--subnav-active-text-color;
          }
        }
      }
    }
  }
  .subnav-icon {
    padding: 2px;
    height: 16px;
    margin-right: 12px;
    svg {
      width: 16px;
      height: 16px;
    }
  }
</style>
