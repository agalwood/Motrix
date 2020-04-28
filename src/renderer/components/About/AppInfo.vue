<template>
  <div class="app-info">
    <div class="app-version">
      <mo-logo :width="93" :height="21" style="vertical-align: bottom;" />
      <span>Version {{version}}</span>
    </div>
    <div class="app-icon"></div>
    <div class="engine-info" v-if="!!engine">
      <h4>{{ $t('about.engine-version') }} {{engine.version}}</h4>
      <ul v-if="!isMas()">
        <li
          v-for="(feature, index) in engine.enabledFeatures"
          v-bind:key="`feature-${index}`">
          {{ feature }}
        </li>
      </ul>
    </div>
  </div>
</template>

<script>
  import is from 'electron-is'
  import Logo from '@/components/Logo/Logo'

  export default {
    name: 'mo-app-info',
    components: {
      [Logo.name]: Logo
    },
    props: {
      version: {
        type: String,
        default: ''
      },
      engine: {
        type: Object,
        default () {
          return {
            version: '',
            enabledFeatures: []
          }
        }
      }
    },
    methods: {
      isMas: is.mas
    }
  }
</script>

<style lang="scss">
  .app-info {
    position: relative;
    margin: 8px 0;
    .app-version span {
      display: inline-block;
      vertical-align: bottom;
      font-size: $--font-size-large;
      margin-left: 20px;
      color: $--app-version-color;
      line-height: 18px;
    }
    .app-icon {
      position: absolute;
      top: 0;
      right: 0;
      background: transparent url('~@/assets/app-icon.png') center center no-repeat;
      background-size: 128px 128px;
      width: 128px;
      height: 128px;
    }
    .engine-info {
      margin: 50px 35% 0 8px;
      h4 {
        font-size: $--font-size-base;
        font-weight: normal;
        color: $--app-engine-title-color;
      }
      ul {
        font-size: 12px;
        color: $--app-engine-info-color;
        list-style: none;
        padding: 0;
        line-height: 20px;
        @include clearfix();
        li {
          float: left;
          width: 50%;
        }
      }
    }
  }
</style>
