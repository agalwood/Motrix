<template>
  <el-button
    class="select-directory"
    @click.stop="onFolderClick"
  >
    <mo-icon name="folder" width="10" height="10" />
  </el-button>
</template>

<script>
  import { dialog } from '@electron/remote'
  import '@/components/Icons/folder'

  export default {
    name: 'mo-select-directory',
    props: {
    },
    methods: {
      onFolderClick () {
        const self = this
        dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory']
        }).then(({ canceled, filePaths }) => {
          if (canceled || filePaths.length === 0) {
            return
          }

          const [path] = filePaths
          self.$emit('selected', path)
        })
      }
    }
  }
</script>
