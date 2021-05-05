<template>
  <el-tag :effect="theme" class="tag-task-status" :type="type">
    {{ status && status.toUpperCase() }}
  </el-tag>
</template>

<script>
  import { APP_THEME, TASK_STATUS } from '@shared/constants'
  import colors from '@shared/colors'

  const statusTypeMap = {
    [TASK_STATUS.ACTIVE]: 'success',
    [TASK_STATUS.WAITING]: 'info',
    [TASK_STATUS.PAUSED]: 'info',
    [TASK_STATUS.ERROR]: 'danger',
    [TASK_STATUS.COMPLETE]: 'success',
    [TASK_STATUS.REMOVED]: 'info',
    [TASK_STATUS.SEEDING]: 'success'
  }

  export default {
    name: 'mo-task-status',
    props: {
      theme: {
        type: String,
        default: APP_THEME.DARK,
        validator: function (value) {
          return [APP_THEME.LIGHT, APP_THEME.DARK].indexOf(value) !== -1
        }
      },
      status: {
        type: String,
        default: TASK_STATUS.ACTIVE
      }
    },
    computed: {
      type () {
        return statusTypeMap[this.status]
      },
      color () {
        return colors[this.status]
      }
    }
  }
</script>
