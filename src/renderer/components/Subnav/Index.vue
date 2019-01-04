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
</style>
