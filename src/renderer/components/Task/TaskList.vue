<template>
  <vue-draggable v-model="$store.state.taskList" v-if="taskList.length > 0"
    @start="isDragging = true" @end="isDragging = false"
    :options="{ animation: 100, ghostClass: 'drag-ghost' }"
  >
    <transition-group name="task-item" tag="ul" class="task-list">
      <mo-task-item v-for="task in taskList" :key="task.gid" :task="task" />
    </transition-group>
  </vue-draggable>
  <div class="no-task" v-else>
    <div class="no-task-inner">
      {{ $t('task.no-task') }}
    </div>
  </div>
</template>

<script>
  import { mapState } from 'vuex'
  import TaskItem from './TaskItem'
  import VueDraggable from 'vuedraggable'

  export default {
    name: 'mo-task-list',
    components: {
      [TaskItem.name]: TaskItem,
      VueDraggable
    },
    data: () => ({
      isDragging: false
    }),
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
  .drag-ghost {
    opacity: 0.3;
  }
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
  .task-item-enter {
    opacity: 0;
    transform: translateX(-100%);
  }
  .task-item-leave-to {
    opacity: 0;
    transform: translateX(100%);
  }
</style>
