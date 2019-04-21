<template>
  <i @click.stop="onFolderClick">
    <mo-icon name="folder" width="10" height="10" />
  </i>
</template>

<script>
  import '@/components/Icons/folder'

  export default {
    name: 'mo-show-in-folder',
    props: {
      path: {
        type: String
      }
    },
    computed: {
    },
    methods: {
      onFolderClick: function () {
        if (!this.path) {
          return
        }
        this.$electron.shell.showItemInFolder(this.path, {
          errorMsg: this.$t('task.file-not-exist')
        })
      }
    }
  }
</script>

<style lang="scss">
</style>
