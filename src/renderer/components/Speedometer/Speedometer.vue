<template>
  <div class="mo-speedometer" :class="{ stopped: stat.numActive === 0 }">
    <div
      class="mode"
      @click="toggleEngineMode"
    >
      <i>
        <mo-icon name="speedometer" width="24" height="24" />
      </i>
      <em>{{ engineMode }}</em>
    </div>
    <div class="value" v-if="stat.numActive > 0">
      <em >{{ stat.uploadSpeed | bytesToSize }}/s</em>
      <span>{{ stat.downloadSpeed | bytesToSize }}/s</span>
    </div>
  </div>
</template>

<script>
  import { mapState, mapActions } from 'vuex'
  import '@/components/Icons/speedometer'
  import {
    bytesToSize
  } from '@shared/utils'

  export default {
    name: 'mo-speedometer',
    components: {
    },
    computed: {
      ...mapState('app', [
        'stat'
      ]),
      ...mapState('preference', [
        'engineMode'
      ])
    },
    filters: {
      bytesToSize
    },
    methods: {
      ...mapActions('preference', [
        'toggleEngineMode'
      ])
    }
  }
</script>

<style lang="scss">
  .mo-speedometer {
    font-size: 12px;
    position: relative;
    display: inline-block;
    box-sizing: border-box;
    width: 150px;
    height: 40px;
    padding: 5px 10px 5px 48px;
    border-radius: 100px;
    transition: $--all-transition;
    border: 1px solid $--speedometer-border-color;
    background: $--speedometer-background;
    &:hover {
      border-color: $--speedometer-hover-border-color;
    }
    &.stopped {
      width: 40px;
      padding: 0;
      .mode i {
        color: $--speedometer-stopped-color;
      }
      .mode em {
        display: none;
      }

    }
    em {
      font-style: normal;
    }
    .mode {
      font-size: 0;
      position: absolute;
      top: 5px;
      left: 5px;
    }
    .mode i {
      font-size: 20px;
      font-style: normal;
      line-height: 28px;
      display: inline-block;
      box-sizing: border-box;
      width: 28px;
      height: 28px;
      padding: 2px;
      text-align: center;
      vertical-align: top;
      color: $--speedometer-primary-color;
    }
    .mode em {
      display: inline-block;
      width: 0;
      height: 8px;
      margin-left: 4px;
      font-size: 16px;
      line-height: 15px;
      transform: scale(.5);
      vertical-align: top;
      color: $--speedometer-primary-color;
    }
    .mode.mode-auto em {
      color: $--speedometer-text-color;
    }
    .mode.mode-max em {
      color: $--speedometer-primary-color;
    }
    .value {
      font-size: 0;
      overflow: hidden;
      width: 100%;
      text-align: right;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .value em {
      font-size: 16px;
      line-height: 12px;
      display: block;
      width: 120%;
      transform: scale(.625);
      color: $--speedometer-text-color;
    }
    .value span {
      font-size: 13px;
      line-height: 14px;
      display: block;
      margin-top: 2px;
      color: $--speedometer-primary-color;
    }
    .no-active {
      font-size: 14px;
      line-height: 28px;
      color: $--speedometer-primary-color;
    }
  }
</style>
