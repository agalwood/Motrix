
export default class HistoryManager {
  constructor () {
    this.tasks = []
    console.log('[Motrix] HistoryManager initialized (Memory Only)')
  }

  add (task) {
    const exists = this.tasks.find(t => t.gid === task.gid)
    if (exists) return

    this.tasks.unshift({
      ...task,
      completedTime: Date.now()
    })

    if (this.tasks.length > 1000) {
      this.tasks.pop()
    }
  }

  getAll () {
    return this.tasks
  }

  remove (gid) {
    this.tasks = this.tasks.filter(t => t.gid !== gid)
  }

  clear () {
    this.tasks = []
  }
}
