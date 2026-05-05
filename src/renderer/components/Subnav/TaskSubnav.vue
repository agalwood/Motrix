<template>
  <nav class="subnav-inner">
    <h3>{{ title }}</h3>
    <ul>
      <li
        @click="() => nav('active')"
        :class="[ current === 'active' ? 'active' : '' ]"
      >
        <i class="subnav-icon">
          <mo-icon name="task-start" width="20" height="20" />
        </i>
        <span>{{ $t('task.active') }}</span>
      </li>
      <li
        @click="() => nav('waiting')"
        :class="[ current === 'waiting' ? 'active' : '' ]"
      >
        <i class="subnav-icon">
          <mo-icon name="task-pause" width="20" height="20" />
        </i>
        <span>{{ $t('task.waiting') }}</span>
      </li>
      <li
        @click="() => nav('stopped')"
        :class="[ current === 'stopped' ? 'active' : '' ]"
      >
        <i class="subnav-icon">
          <mo-icon name="task-stop" width="20" height="20" />
        </i>
        <span>{{ $t('task.stopped') }}</span>
      </li>
      <li
        @click="() => nav('history')"
        :class="[ current === 'history' ? 'active' : '' ]"
      >
        <i class="subnav-icon">
          <mo-icon name="task-history" width="20" height="20" />
        </i>
        <span>{{ $t('task.history') }}</span>
      </li>
    </ul>
  </nav>
</template>

<script>
  import '@/components/Icons/task-start'
  import '@/components/Icons/task-pause'
  import '@/components/Icons/task-stop'
  import '@/components/Icons/task-history'

  export default {
    name: 'mo-task-subnav',
    props: {
      current: {
        type: String,
        default: 'active'
      }
    },
    computed: {
      title () {
        return this.$t('subnav.task-list')
      }
    },
    methods: {
      nav (status = 'active') {
        this.$router.push({
          path: `/task/${status}`
        }).catch(err => {
          console.log(err)
        })
      }
    }
  }
</script>
