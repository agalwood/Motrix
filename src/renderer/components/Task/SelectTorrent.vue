<template>
  <el-upload
    class="upload-torrent"
    drag
    action="/"
    accept=".torrent"
    :on-change="handleChange"
    :auto-upload="false"
    :show-file-list="false">
    <i class="upload-inbox-icon"><mo-icon name="inbox" width="24" height="24" /></i>
    <div class="el-upload__text">
      {{ $t('task.select-torrent') }}
      <div class="torrent-name" v-if="name">{{ name }}</div>
    </div>
  </el-upload>
</template>

<script>
  import { mapState } from 'vuex'
  import parseTorrent from 'parse-torrent'
  import '@/components/Icons/inbox'
  import { getAsBase64 } from '@shared/utils'

  export default {
    name: 'mo-select-torrent',
    components: {
    },
    props: {
    },
    data () {
      return {
        name: ''
      }
    },
    computed: {
      ...mapState('preference', {
        config: state => state.config
      })
    },
    methods: {
      handleChange (file, fileList) {
        console.log('file===>', file)
        if (!file.raw) {
          return
        }

        parseTorrent.remote(file.raw, (err, parsedTorrent) => {
          if (err) throw err
          console.log(parsedTorrent)
        })

        getAsBase64(file.raw, (torrent) => {
          this.name = file.name
          this.$emit('change', torrent, file, fileList)
        })
      }
    }
  }
</script>

<style lang="scss">
  .upload-torrent {
    width: 100%;
    .el-upload, .el-upload-dragger {
      width: 100%;
    }
    .el-upload-dragger {
      border-radius: 4px;
      padding: 24px;
      height: auto;
    }
    .upload-inbox-icon {
      display: inline-block;
      margin-bottom: 12px;
    }
    .torrent-name {
      margin-top: 4px;
      font-size: $--font-size-small;
      color: $--color-text-secondary;
      line-height: 16px;
    }
  }
</style>
