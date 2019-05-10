<template>
  <el-row class="copyright">
    <el-col :span="6" class="copyright-left">
      <a target="_blank" href="https://motrix.app/" rel="noopener noreferrer">
        &copy;2018 Motrix
      </a>
    </el-col>
    <el-col :span="18" class="copyright-right">
      <a target="_blank" href="https://motrix.app/license" rel="noopener noreferrer">
        {{ $t('about.license') }}
      </a>
      <a target="_blank" href="https://motrix.app/about" rel="noopener noreferrer">
        {{ $t('about.about') }}
      </a>
      <a target="_blank" href="https://motrix.app/support" rel="noopener noreferrer">
        {{ $t('about.support') }}
      </a>
      <a target="_blank" href="https://motrix.app/release" rel="noopener noreferrer">
        {{ $t('about.release') }}
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
      color: $--app-copyright-color;
      text-decoration: none;
    }
  }
  .copyright-left {
    text-align: left;
  }

  .copyright-right {
    text-align: right;
    a {
      margin-left: 30px;
    }
  }
</style>
