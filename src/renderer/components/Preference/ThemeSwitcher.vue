<template>
  <div>
    <ul class="theme-switcher">
      <li
        v-for="item in themeOptions"
        :class="['theme-item', item.className, { active: currentValue === item.value }]"
        :key="item.value"
        @click.prevent="() => handleChange(item.value)"
      >
        <div class="theme-thumb"></div>
        <span>{{ item.text }}</span>
      </li>
    </ul>
  </div>
</template>

<script>
  import { APP_THEME } from '@shared/constants'

  export default {
    name: 'mo-theme-switcher',
    components: {
    },
    props: {
      value: {
        type: String,
        default: APP_THEME.AUTO
      }
    },
    data () {
      return {
        currentValue: this.value
      }
    },
    computed: {
      themeOptions () {
        return [
          {
            className: 'theme-item-auto',
            value: APP_THEME.AUTO,
            text: this.$t('preferences.theme-auto')
          },
          {
            className: 'theme-item-light',
            value: APP_THEME.LIGHT,
            text: this.$t('preferences.theme-light')
          },
          {
            className: 'theme-item-dark',
            value: APP_THEME.DARK,
            text: this.$t('preferences.theme-dark')
          }
        ]
      }
    },
    watch: {
      currentValue (val) {
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
      font-size: 13px;
      line-height: 20px;
    }
    &.active {
      .theme-thumb {
        border-color: $--color-primary;
        box-shadow: 0 0 1px $--color-primary;
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
    border: 1px solid #aaa;
    border-radius: 5px;
    width: 68px;
    height: 44px;
    margin-bottom: 8px;
  }
}
</style>
