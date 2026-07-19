import { app } from 'electron'
import path from 'path'
import Database from 'better-sqlite3'
import logger from './Logger'

export default class HistoryManager {
  constructor () {
    const dbPath = path.join(app.getPath('userData'), 'history.sqlite')
    this.db = new Database(dbPath)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_history (
        gid TEXT PRIMARY KEY,
        task_data TEXT NOT NULL,
        completedTime INTEGER NOT NULL
      )
    `)

    this.tasks = this.loadFromDB()
    logger.info('[Motrix] HistoryManager initialized with SQLite at ' + dbPath)
  }

  loadFromDB () {
    try {
      const stmt = this.db.prepare('SELECT task_data, completedTime FROM task_history ORDER BY completedTime DESC LIMIT 1000')
      const rows = stmt.all()
      return rows.map(row => {
        const task = JSON.parse(row.task_data)
        task.completedTime = row.completedTime
        return task
      })
    } catch (e) {
      logger.warn('[Motrix] HistoryManager failed to load from DB:', e)
      return []
    }
  }

  add (task) {
    const exists = this.tasks.find(t => t.gid === task.gid)
    if (exists) return

    const completedTime = Date.now()
    const taskToSave = { ...task, completedTime }

    this.tasks.unshift(taskToSave)
    if (this.tasks.length > 1000) {
      const removed = this.tasks.pop()
      try {
        this.db.prepare('DELETE FROM task_history WHERE gid = ?').run(removed.gid)
      } catch (e) {}
    }

    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO task_history (gid, task_data, completedTime) VALUES (?, ?, ?)')
      insert.run(task.gid, JSON.stringify(taskToSave), completedTime)
    } catch (e) {
      logger.warn('[Motrix] HistoryManager failed to insert into DB:', e)
    }
  }

  getAll () {
    return this.tasks
  }

  remove (gid) {
    this.tasks = this.tasks.filter(t => t.gid !== gid)
    try {
      this.db.prepare('DELETE FROM task_history WHERE gid = ?').run(gid)
    } catch (e) {}
  }

  clear () {
    this.tasks = []
    try {
      this.db.exec('DELETE FROM task_history')
    } catch (e) {}
  }
}
