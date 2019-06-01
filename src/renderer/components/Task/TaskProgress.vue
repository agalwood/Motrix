<template>
  <el-progress
    v-if="status === 'active'"
    :percentage="percent"
    :show-text="false"
    status="success"
    :color="color">
  </el-progress>
  <el-progress
    v-else
    :percentage="percent"
    :show-text="false"
    :color="color">
  </el-progress>
</template>

<script>
  import { calcProgress } from '@shared/utils'
  import colors from '@shared/colors'

  export default {
    name: 'mo-task-progress',
    props: {
      total: {
        type: Number
      },
      completed: {
        type: Number
      },
      status: {
        type: String,
        default: 'active'
      }
    },
    computed: {
      percent: function () {
        return calcProgress(this.total, this.completed)
      },
      color: function () {
        return colors[this.status]
      }
    },
    methods: {
    }
  }
</script>

<style lang="scss">
</style>
