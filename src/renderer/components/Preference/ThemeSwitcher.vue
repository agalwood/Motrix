<template>
  <div>
    <ul class="theme-switcher">
      <li
        class="theme-item theme-item-auto"
        :class="{ active: currentValue === 'auto' }"
        @click.prevent="() => handleChange('auto')"
      >
        <div class="theme-thumb"></div>
        <span>{{ $t('preferences.theme-auto') }}</span>
      </li>
      <li
        class="theme-item theme-item-light"
        :class="{ active: currentValue === 'light' }"
        @click.prevent="() => handleChange('light')"
      >
        <div class="theme-thumb"></div>
        <span>{{ $t('preferences.theme-light') }}</span>
      </li>
      <li
        class="theme-item theme-item-dark"
        :class="{ active: currentValue === 'dark' }"
        @click.prevent="() => handleChange('dark')"
      >
        <div class="theme-thumb"></div>
        <span>{{ $t('preferences.theme-dark') }}</span>
      </li>
    </ul>
  </div>
</template>

<script>
  export default {
    name: 'mo-theme-switcher',
    components: {
    },
    props: {
      value: {
        type: String,
        default: 'auto'
      }
    },
    data: function () {
      return {
        currentValue: this.value
      }
    },
    watch: {
      currentValue: function (val) {
        this.$emit('change', val)
      }
    },
    methods: {
      handleChange (theme) {
        this.currentValue = theme
      }
    }
  }
</script>

<style lang="scss">
.theme-switcher {
  padding: 0;
  margin: 0;
  font-size: 0;
  line-height: 0;
  .theme-item {
    text-align: center;
    display: inline-block;
    margin: 0 16px 0 0;
    cursor: pointer;
    span {
      font-size: 14px;
      line-height: 20px;
    }
    &.active {
      .theme-thumb {
        border-color: $--color-primary;
      }
      span {
        color: $--color-primary;
      }
    }
    &.theme-item-auto .theme-thumb {
      background: url('~@/assets/theme-auto@2x.png') center center no-repeat;
      background-size: 68px 44px;
    }
    &.theme-item-light .theme-thumb {
      background: url('~@/assets/theme-light@2x.png') center center no-repeat;
      background-size: 68px 44px;
    }
    &.theme-item-dark .theme-thumb {
      background: url('~@/assets/theme-dark@2x.png') center center no-repeat;
      background-size: 68px 44px;
    }
  }
  .theme-thumb {
    box-sizing: border-box;
    border: 2px solid #aaa;
    border-radius: 5px;
    width: 68px;
    height: 44px;
    margin-bottom: 8px;
  }
}
</style>
