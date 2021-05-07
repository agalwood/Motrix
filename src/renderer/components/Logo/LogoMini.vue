<template>
  <h1 class="logo-mini">
    <a target="_blank" href="https://motrix.app/">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 14">
        <path fill="#FFF" fill-rule="evenodd" d="M4,9 L28,9 C29,9 30,10 30,11 L30,23 L26,23 L26,12.5 C26,12 25.5,11.5 25,11.5 L18,11.5 L18,23 L14,23 L14,11.5 L7,11.5 C6.5,11.5 6,12 6,12.5 L6,23 L2,23 L2,11 C2,10 3,9 4,9 Z" transform="translate(-2 -9)"/>
      </svg>
    </a>
  </h1>
</template>

<script>
  export default {
    name: 'mo-logo-mini'
  }
</script>

<style lang="scss">
.logo-mini {
  margin: 0;
  padding: 0;
  width: 100%;
  > a {
    display: block;
    width: 28px;
    height: 28px;
    text-align: center;
    font-size: 0;
    padding: 2px;
    margin: 0 auto;
  }
}
</style>
