<script>
export default {
  name: 'mo-dragger',
  mounted () {
    this.preventDefault = ev => ev.preventDefault()
    let count = 0
    this.onDragEnter = (ev) => {
      count++
      this.$store.dispatch('app/showAddTaskDialog', 'torrent')
    }

    this.onDragLeave = (ev) => {
      count--
      if (count === 0) {
        this.$store.dispatch('app/hideAddTaskDialog')
      }
    }

    document.addEventListener('dragover', this.preventDefault)
    document.body.addEventListener('dragenter', this.onDragEnter)
    document.body.addEventListener('dragleave', this.onDragLeave)
  },
  destroyed () {
    document.removeEventListener('dragover', this.preventDefault)
    document.body.removeEventListener('dragenter', this.onDragEnter)
    document.body.removeEventListener('dragleave', this.onDragLeave)
  }
}
</script>
