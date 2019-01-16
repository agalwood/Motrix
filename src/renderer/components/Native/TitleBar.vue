<template>
  <div class="title-bar">
    <ul v-if="showActions" class="window-actions">
      <li @click="handleMinimize">
        <mo-icon name="win-minimize" width="12" height="12" />
      </li>
      <li @click="handleMaximize">
        <mo-icon name="win-maximize" width="12" height="12" />
      </li>
      <li @click="handleClose">
        <mo-icon name="win-close" width="12" height="12" />
      </li>
    </ul>
  </div>
</template>

<script>
  import '@/components/Icons/win-minimize'
  import '@/components/Icons/win-maximize'
  import '@/components/Icons/win-close'

  export default {
    name: 'mo-title-bar',
    props: {
      showActions: {
        type: Boolean
      }
    },
    computed: {
      win: function () {
        return this.$electron.remote.getCurrentWindow()
      }
    },
    methods: {
      handleMinimize: function () {
        this.win.minimize()
      },
      handleMaximize: function () {
        if (this.win.isMaximized()) {
          this.win.unmaximize()
        } else {
          this.win.maximize()
        }
      },
      handleClose: function () {
        this.win.close()
      }
    }
  }
</script>

<style lang="scss">
  .window-actions {
    position: fixed;
    top: 0;
    right: 24px;
    list-style: none;
    padding: 0;
    margin: 0;
    > li {
      float: left;
      padding: 5px 10px;
      &:hover {
        background-color: $--titlebar-actions-active-background;
      }
    }
  }
</style>
