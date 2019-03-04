<template>
  <ul class="task-list" v-if="taskList.length > 0">
    <mo-task-item v-for="task in taskList" :key="task.gid" :task="task" />
  </ul>
  <div class="no-task" v-else>
    <div class="no-task-inner">
      {{ $t('task.no-task') }}
    </div>
  </div>
</template>

<script>
  import { mapState } from 'vuex'
  import TaskItem from './TaskItem'

  export default {
    name: 'mo-task-list',
    components: {
      [TaskItem.name]: TaskItem
    },
    computed: {
      ...mapState('task', {
        taskList: state => state.taskList
      })
    },
    methods: {
    }
  }
</script>

<style lang="scss">
  .task-list {
    list-style: none;
    padding: 0;
  }
  .no-task {
    display: flex;
    height: 100%;
    text-align: center;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    color: #555;
  }
  .no-task-inner {
    width: 100%;
    padding-top: 360px;
    background: transparent url('~@/assets/no-task.svg') top center no-repeat;
  }
</style>
