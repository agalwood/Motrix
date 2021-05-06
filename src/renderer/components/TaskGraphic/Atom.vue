<template>
  <rect
    :class="klass"
    :status="status"
    :width="width"
    :height="height"
    :rx="radius"
    :ry="radius"
    :x="x"
    :y="y"
    >
  </rect>
</template>

<script>
  export default {
    name: 'mo-task-graphic-atom',
    props: {
      status: {
        type: Number
      },
      width: {
        type: Number,
        default: 10
      },
      height: {
        type: Number,
        default: 10
      },
      radius: {
        type: Number,
        default: 2
      },
      x: {
        type: Number
      },
      y: {
        type: Number
      }
    },
    computed: {
      klass () {
        const { status } = this
        return `graphic-atom graphic-atom-s${status}`
      }
    }
  }
</script>

<style lang="scss">
.graphic-atom {
  shape-rendering: geometricPrecision;
  outline-offset: -1px;
}
.graphic-atom-s0 {
  fill: $--graphic-atom-color-0;
  outline: 1px solid $--graphic-atom-outline-color;
}
.graphic-atom-s1 {
  fill: $--graphic-atom-color-1;
  outline: 1px solid $--graphic-atom-outline-color;
}
.graphic-atom-s2 {
  fill: $--graphic-atom-color-2;
  outline: 1px solid $--graphic-atom-outline-color;
}
.graphic-atom-s3 {
  fill: $--graphic-atom-color-3;
  outline: 1px solid $--graphic-atom-outline-color;
}
.graphic-atom-s4 {
  fill: $--graphic-atom-color-4;
  outline: 1px solid $--graphic-atom-outline-color;
}
</style>
