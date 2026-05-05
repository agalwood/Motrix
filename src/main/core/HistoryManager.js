import Store from 'electron-store'
import { getConfigBasePath } from '../utils/index'

export default class HistoryManager {
  constructor () {
    this.store = new Store({
      name: 'history',
      cwd: getConfigBasePath(),
      defaults: {
        tasks: []
      }
    })
  }

  add (task) {
    const tasks = this.store.get('tasks', [])
    // Avoid duplicates by GID
    const exists = tasks.find(t => t.gid === task.gid)
    if (exists) {
      return
    }

    // Add timestamp
    const record = {
      ...task,
      completedTime: Date.now()
    }

    tasks.unshift(record)

    // Keep only last 1000 records
    if (tasks.length > 1000) {
      tasks.pop()
    }

    this.store.set('tasks', tasks)
  }

  getAll () {
    return this.store.get('tasks', [])
  }

  remove (gid) {
    const tasks = this.store.get('tasks', [])
    const newTasks = tasks.filter(t => t.gid !== gid)
    this.store.set('tasks', newTasks)
  }

  clear () {
    this.store.set('tasks', [])
  }
}
