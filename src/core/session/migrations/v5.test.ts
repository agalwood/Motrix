import { TaskStatus, TransitionPhase } from '@shared/types/task'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate } from '.'
import { v1 } from './v1'
import { v2 } from './v2'
import { v3 } from './v3'
import { v4 } from './v4'

function createV4(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`)
  for (const migration of [v1, v2, v3, v4]) {
    migration.up(db)
    db.prepare('INSERT INTO schema_version VALUES (?, 1)').run(
      migration.version
    )
  }
  return db
}

describe('task recovery migration v5', () => {
  it('upgrades existing tasks and recovers the original root from their journal', () => {
    const db = createV4()
    db.exec(`INSERT INTO tasks (motrix_id, name, task_type, created_at, updated_at, final_path)
      VALUES ('interrupted', 'movie', 'bt', 1, 1, '/downloads/Movies/movie'),
        ('legacy', 'file', 'http', 1, 1, '/downloads/file')`)
    db.prepare(`INSERT INTO plugin_finalize_journals
      (plan_id, task_id, phase, plan_json, source_identity_json, created_at, updated_at)
      VALUES ('plan', 'interrupted', 'prepared', ?, '{}', 1, 1)`).run(
      JSON.stringify({
        saveDir: '/downloads',
        targetPath: '/downloads/Movies/movie',
      })
    )
    migrate(db)
    expect(
      db
        .prepare('SELECT save_dir FROM tasks WHERE motrix_id = ?')
        .get('interrupted')
    ).toEqual({ save_dir: '/downloads' })
    expect(
      db.prepare('SELECT save_dir FROM tasks WHERE motrix_id = ?').get('legacy')
    ).toEqual({ save_dir: null })
    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({
      n: 2,
    })
    db.close()
  })

  it('repairs only terminal instance statuses, preserving recovery intent and event history', () => {
    const db = createV4()
    const insertTask = db.prepare(`INSERT INTO tasks
      (motrix_id, name, task_type, created_at, updated_at, final_path,
        agg_status, finished_at, error_message, diagnosis_revision)
      VALUES (?, 'output', 'http', 1000, 2000, '/downloads/category/output', ?, 3000, 'retained detail', 4)`)
    const insertInstance = db.prepare(`INSERT INTO task_instances
      (instance_id, motrix_id, gid, phase, status, progress, disk_path,
        transition_phase, payload, created_at, updated_at)
      VALUES (?, ?, ?, 'http_download', ?, 42, '/downloads/output.motrix', ?, '{"retained":true}', 1000, 2000)`)
    for (const status of Object.values(TaskStatus)) {
      insertTask.run(status, status)
      for (const [index, phase] of Object.values(TransitionPhase).entries()) {
        insertInstance.run(
          `${status}-${index}`,
          status,
          `gid-${status}-${index}`,
          [TaskStatus.Queued, TaskStatus.Downloading, status][index],
          phase
        )
      }
    }
    const tasksBefore = db
      .prepare('SELECT * FROM tasks ORDER BY motrix_id')
      .all()
    const readInstances = db.prepare(
      'SELECT * FROM task_instances ORDER BY instance_id'
    )
    const instancesBefore = readInstances.all() as Array<{
      motrix_id: TaskStatus
      status: TaskStatus
    }>

    migrate(db)

    expect(readInstances.all()).toEqual(
      instancesBefore.map((entry) => ({
        ...entry,
        status:
          entry.motrix_id === TaskStatus.Error ||
          entry.motrix_id === TaskStatus.Completed
            ? entry.motrix_id
            : entry.status,
      }))
    )
    expect(db.prepare('SELECT * FROM tasks ORDER BY motrix_id').all()).toEqual(
      tasksBefore.map((entry) => ({ ...(entry as object), save_dir: null }))
    )
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM task_occurrences').get()
    ).toEqual({ count: 0 })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM plugin_post_deliveries').get()
    ).toEqual({ count: 0 })
    const changes = db.prepare('SELECT total_changes() AS count').get()
    migrate(db)
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes)
    expect(
      db.prepare('SELECT version FROM schema_version ORDER BY version').all()
    ).toEqual([1, 2, 3, 4, 5].map((version) => ({ version })))
    db.close()
  })
})
