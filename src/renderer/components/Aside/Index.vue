<template>
  <el-aside width="78px" :class="['aside', 'hidden-sm-and-down', { 'draggable': asideDraggable }]" :style="vibrancy">
    <div class="aside-inner">
      <mo-logo-mini />
      <ul class="menu top-menu">
        <li @click="nav('/task')" class="non-draggable">
          <mo-icon name="menu-task" width="20" height="20" />
        </li>
        <li @click="showAddTask()" class="non-draggable">
          <mo-icon name="menu-add" width="20" height="20" />
        </li>
      </ul>
      <ul class="menu bottom-menu">
        <li @click="nav('/preference')" class="non-draggable">
          <mo-icon name="menu-preference" width="20" height="20" />
        </li>
        <li @click="showAboutPanel" class="non-draggable">
          <mo-icon name="menu-about" width="20" height="20" />
        </li>
      </ul>
    </div>
  </el-aside>
</template>

<script>
  import is from 'electron-is'
  import { mapState } from 'vuex'
  import { ADD_TASK_TYPE } from '@shared/constants'
  import LogoMini from '@/components/Logo/LogoMini'
  import '@/components/Icons/menu-task'
  import '@/components/Icons/menu-add'
  import '@/components/Icons/menu-preference'
  import '@/components/Icons/menu-about'

  export default {
    name: 'mo-aside',
    components: {
      [LogoMini.name]: LogoMini
    },
    computed: {
      ...mapState('app', {
        currentPage: state => state.currentPage
      }),
      asideDraggable () {
        return is.macOS()
      },
      vibrancy () {
        return is.macOS()
          ? {
            backgroundColor: 'transparent'
          }
          : {}
      }
    },
    methods: {
      showAddTask (taskType = ADD_TASK_TYPE.URI) {
        this.$store.dispatch('app/showAddTaskDialog', taskType)
      },
      showAboutPanel () {
        this.$store.dispatch('app/showAboutPanel')
      },
      nav (page) {
        this.$router.push({
          path: page
        }).catch(err => {
          console.log(err)
        })
      }
    }
  }
</script>

<style lang="scss">
.aside {
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  background: rgba(255, 255, 255, 0.88) !important;
  border-right: 1px solid rgba(0, 0, 0, 0.1);
}
.aside-inner {
  display: flex;
  height: 100%;
  flex-flow: column;
}
.logo-mini {
  margin-top: 40px;

  svg path {
    fill: rgba(0, 0, 0, 0.8);
    transition: fill 0.3s ease;
  }

  a:hover svg path {
    fill: rgba(0, 0, 0, 0.95);
  }
}
.menu {
  list-style: none;
  padding: 0;
  margin: 0 auto;
  user-select: none;
  cursor: default;
  > li {
    width: 32px;
    height: 32px;
    margin-top: 24px;
    cursor: pointer;
    border-radius: 16px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    background-color: rgba(0, 0, 0, 0.06);
    &:hover {
      background-color: rgba(0, 0, 0, 0.12);
      transform: scale(1.08);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    &:active {
      transform: scale(0.98);
      background-color: rgba(0, 0, 0, 0.18);
    }
  }
  svg {
    padding: 6px;
    color: rgba(0, 0, 0, 0.85);
    transition: color 0.3s ease;
  }
  > li:hover svg {
    color: rgba(0, 0, 0, 0.95);
  }
}
.top-menu {
  flex: 1;

  > li {
    svg {
      color: rgba(0, 0, 0, 0.85);
    }

    &:hover svg {
      color: rgba(0, 0, 0, 0.95);
    }
  }
}
.bottom-menu {
  margin-bottom: 24px;

  > li {
    background-color: rgba(0, 0, 0, 0.1);
    border: 1px solid rgba(0, 0, 0, 0.12);

    svg {
      color: rgba(0, 0, 0, 0.85);
    }

    &:hover {
      background-color: rgba(0, 0, 0, 0.16);
      border-color: rgba(0, 0, 0, 0.18);

      svg {
        color: rgba(0, 0, 0, 0.95);
      }
    }

    &:active {
      background-color: rgba(0, 0, 0, 0.22);
    }
  }
}
</style>
