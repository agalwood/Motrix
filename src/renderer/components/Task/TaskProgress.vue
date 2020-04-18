<template>
  <el-progress
    v-if="isActive"
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
  import { TASK_STATUS } from '@shared/constants'
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
        default: TASK_STATUS.ACTIVE
      }
    },
    computed: {
      isActive () {
        return this.status === TASK_STATUS.ACTIVE
      },
      percent () {
        return calcProgress(this.total, this.completed)
      },
      color () {
        return colors[this.status]
      }
    }
  }
</script>
