<template>
  <div class="dir-history">
    <el-popover
      popper-class="dir-history-popper"
      placement="bottom-start"
      width="310"
      trigger="manual"
      v-model="visible"
    >
      <ul class="dir-history-list">
        <li v-for="dir in dirHistory" :key="dir" @click.stop="() => handleUseHistory(dir)">
          <span>{{dir}}</span>
          <i class="el-icon-delete dir-history-list-action" @click.stop="() => handleRemoveHistory(dir)" />
        </li>
      </ul>
      <el-button
        slot="reference"
        :disabled="dirHistory.length === 0"
        @click="handleIconClick"
      >
        <i class="el-icon-time" />
      </el-button>
    </el-popover>
  </div>
</template>

<script>
  import { mapState } from 'vuex'

  export default {
    name: 'mo-directory-history',
    components: {
    },
    props: {
      width: {
        type: Number,
        default: 200
      },
      placement: {
        type: String,
        default: 'bottom-start'
      }
    },
    data () {
      return {
        visible: false
      }
    },
    computed: {
      ...mapState('preference', {
        dirHistory: state => state.config.dirHistory
      })
    },
    methods: {
      handleIconClick () {
        if (this.dirHistory.length === 0) {
          return
        }

        const { visible } = this
        this.visible = !visible
      },
      handleUseHistory (dir) {
        this.$emit('selected', dir.trim())
        this.visible = false
      },
      handleRemoveHistory (dir) {
        console.log('handleRemoveHistory==>', dir)
      }
    }
  }
</script>

<style lang="scss">
.el-popover.dir-history-popper {
  padding: $--popover-padding 0;
}

.dir-history-list {
  padding: 0;
  margin: 0;
  list-style: none;
  &> li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    list-style: none;
    line-height: $--font-line-height-primary;
    margin: 0;
    font-size: $--font-size-small;
    color: $--color-text-regular;
    cursor: pointer;
    outline: none;
    padding: 6px $--popover-padding;
    &:focus, &:hover {
      background-color: $--background-color-base;
      color: $--color-primary-light-2;
    }
  }
  .dir-history-list-action {
    &:focus, &:hover {
      color: $--color-danger;
    }
  }
}
</style>
