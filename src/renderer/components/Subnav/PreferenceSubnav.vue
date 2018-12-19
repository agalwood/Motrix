<template>
  <nav class="subnav-inner">
    <h3>{{ title }}</h3>
    <ul>
      <li
        @click="() => nav('basic')"
        v-bind:class="[ current === 'basic' ? 'active' : '' ]"
        >
        <i class="subnav-icon">
          <mo-icon name='preference-basic' width="20" height="20" />
        </i>
        <span>基础设置</span>
      </li>
      <li
        @click="() => nav('advanced')"
        v-bind:class="[ current === 'advanced' ? 'active' : '' ]"
        >
        <i class="subnav-icon">
          <mo-icon name='preference-advanced' width="20" height="20" />
        </i>
        <span>进阶设置</span>
      </li>
      <li
        @click="() => nav('lab')"
        v-bind:class="[ current === 'lab' ? 'active' : '' ]"
        >
        <i class="subnav-icon">
          <mo-icon name='preference-lab' width="20" height="20" />
        </i>
        <span>实验室</span>
      </li>
    </ul>
  </nav>
</template>

<script>
  import is from 'electron-is'
  import '@/components/Icons/preference-basic'
  import '@/components/Icons/preference-advanced'
  import '@/components/Icons/preference-lab'

  export default {
    name: 'mo-preference-subnav',
    props: {
      current: {
        type: String,
        default: 'basic'
      }
    },
    computed: {
      title: function () {
        return '偏好设置'
      }
    },
    methods: {
      isMas: is.mas,
      nav: function (category = 'basic') {
        console.log('nav category===>', category)
        this.$router.push({
          path: `/preference/${category}`
        })
      }
    }
  }
</script>

<style lang="scss">
</style>
