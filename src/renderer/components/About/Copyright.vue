<template>
  <el-row class="copyright">
    <el-col :span="8" class="copyright-left">
      <a target="_blank" href="https://motrix.app/" rel="noopener noreferrer">
        &copy;2018 Motrix
      </a>
    </el-col>
    <el-col :span="16" class="copyright-right">
      <a target="_blank" href="https://motrix.app/about" rel="noopener noreferrer">
        {{ $t('about.about') }}
      </a>
      <a target="_blank" href="https://motrix.app/support" rel="noopener noreferrer">
        {{ $t('about.support') }}
      </a>
    </el-col>
  </el-row>
</template>

<script>
  export default {
    name: 'mo-copyright'
  }
</script>

<style lang="scss">
  .copyright {
    width: 100%;
    font-size: $--font-size-small;
    a {
      color: $--color-text-regular;
      text-decoration: none;
    }
  }
  .copyright-left {
    text-align: left;
    a {
      color: $--color-text-regular;
    }
  }

  .copyright-right {
    text-align: right;
    a {
      margin-left: 30px;
    }
  }
</style>
